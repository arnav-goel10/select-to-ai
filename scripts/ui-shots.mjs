// Screenshots every extension page (light + dark) for design review.
//   node scripts/ui-shots.mjs [outDir] [state]
// state: "fresh" (no key, onboarding pending) or "ready" (key saved).
import puppeteer from "puppeteer";
import path from "node:path";
import fs from "node:fs";
const EXT = path.resolve("extension");
const OUT = path.resolve(process.argv[2] || "ui-shots");
const STATE = process.argv[3] || "ready";
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});
const worker = await (await browser.waitForTarget((t) => t.type() === "service_worker")).worker();
const id = new URL((await browser.waitForTarget((t) => t.type() === "service_worker")).url()).host;
await new Promise((r) => setTimeout(r, 800));
for (const p of await browser.pages()) if (p.url().startsWith("chrome-extension")) await p.close();
await worker.evaluate(async (ready) => {
  await chrome.storage.local.clear();
  await chrome.storage.sync.clear();
  if (ready) {
    await chrome.storage.sync.set({ showAgent: true, agentActiveProvider: "openrouter" });
    await chrome.storage.local.set({ agentOpenRouterKey: "sk-or-v1-demo", onboardingComplete: true });
  }
}, STATE === "ready");
const pages = [
  ["popup", 380, 560], ["options", 1280, 900], ["welcome", 1280, 900],
  ["sidepanel", 400, 800], ["agent", 1280, 860],
];
for (const scheme of ["light", "dark"]) {
  for (const [name, w, h] of pages) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.goto(`chrome-extension://${id}/${name}.html`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: `${OUT}/${name}-${scheme}.png`, fullPage: name === "options" || name === "welcome" });
    await page.close();
  }
}
await browser.close();
console.log(`shots in ${OUT}`);
