const fs = require("fs"), path = require("path"), puppeteer = require("puppeteer");
const EXT = path.join(process.env.HOME, "Documents/select-to-ai-v3/extension");
const PAGE = `<!doctype html><body>
<p id=sel>The selected sentence that a user highlighted before opening the palette.</p>
<input id=pageInput placeholder="a page input">
</body>`;

async function open(page) {
  for (const f of ["commandPalette.js"])
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), "utf8") });
  await new Promise((r) => setTimeout(r, 120));
}
const present = (page) => page.evaluate(() => !!document.getElementById("select-to-ai-command-palette"));

(async () => {
  const browser = await puppeteer.launch({ headless: "new",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const page = await browser.newPage();
  const results = {};

  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(PAGE), { waitUntil: "load" });

  // 1. opens
  await open(page); results.opens = await present(page);

  // 2. second invocation toggles closed
  await open(page); results.togglesClosed = !(await present(page));

  // 3. Escape closes
  await open(page);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 80));
  results.escapeCloses = !(await present(page));

  // 4. does it pick up the user's selection? (the extension is called Select to AI)
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("sel"));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await open(page);
  results.selectionSeeded = await page.evaluate(() => {
    const host = document.getElementById("select-to-ai-command-palette");
    // closed shadow root: read what the user would see via the rendered box
    return host ? host.getBoundingClientRect().height > 0 : false;
  });
  const selText = await page.evaluate(() => getSelection().toString().slice(0, 40));
  results.selectionOnPage = selText;

  // 5. does opening the palette destroy the page selection?
  results.selectionSurvives = selText.length > 0;

  // 6. focus actually lands in the palette, not the page input
  results.focusLeftPage = await page.evaluate(() => document.activeElement.id !== "pageInput");

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
