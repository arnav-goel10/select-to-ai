const path = require("path"), puppeteer = require("puppeteer");
const EXT = path.join(process.env.HOME, "Documents/select-to-ai-v3/extension");
const PAGES = ["options.html", "popup.html", "agent.html", "sidepanel.html"];
const SIZES = { "popup.html": [328, 620], "sidepanel.html": [420, 900] };

(async () => {
  const browser = await puppeteer.launch({ headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  // resolve the generated extension id
  let id = null;
  for (let i = 0; i < 20 && !id; i++) {
    const t = browser.targets().find((t) => t.url().startsWith("chrome-extension://"));
    if (t) id = new URL(t.url()).host;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (!id) { console.log("could not resolve extension id"); await browser.close(); return; }
  console.log("extension id:", id);

  const scheme = process.argv[2] === "dark" ? "dark" : "light";
  for (const p of PAGES) {
    const page = await browser.newPage();
    const [w, h] = SIZES[p] || [1440, 1000];
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    try {
      // Land on the page first so chrome.storage is reachable, mark onboarding
      // done, then reload: the wizard otherwise covers every settings surface.
      await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ onboardingComplete: true }, r)));
      await page.goto(`chrome-extension://${id}/${p}`, { waitUntil: "networkidle0", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 900));
      await page.screenshot({ path: `/tmp/ui-${scheme}-${p.replace(".html", "")}.png` });
      console.log("  captured", p);
    } catch (e) { console.log("  FAILED", p, e.message.split("\n")[0]); }
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
