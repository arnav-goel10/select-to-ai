// Captures the agent's bar (extension/agentBar.js) as it sits on pages the
// agent brought to front: the theme setting on Light and on Dark, on a light
// page and on a dark page, at desktop width and at phone width, plus its
// other states and a page whose CSS tries to leak into it. Shots are saved
// under docs/screenshots/agent-bar/.
//
//   node tests/e2e/agent-bar-screenshot.js
//
// The script is injected into the page's main world, where chrome.* is
// absent, so a small stub answers the theme read the way storage would and
// hands the bar the messages the engine sends (engine.js, syncBar).
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(ROOT, "docs", "screenshots", "agent-bar");

const LIGHT_PAGE = `<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="font-family:Georgia,serif;margin:0;background:#fff;color:#111">
<header style="background:#f3f4f6;padding:18px 28px;font-size:20px;font-weight:600">Fly Direct</header>
<main style="padding:28px;max-width:760px">
<h1 style="font-size:28px;margin:0 0 12px">Search flights</h1>
<p style="color:#374151;line-height:1.7">From Singapore to Tokyo, one way, on 14 November. Prices include taxes and one cabin bag.</p>
<p style="color:#374151;line-height:1.7">ZIPAIR ZG 52, 01:15, S$ 218. Scoot TR 808, 06:40, S$ 241. Singapore Airlines SQ 638, 23:05, S$ 512.</p>
<button style="padding:10px 16px;font-size:16px">Search</button>
</main><footer style="position:fixed;left:0;right:0;bottom:0;background:#111827;color:#fff;padding:14px 28px;font:14px sans-serif">Cookies help us run this site. <button>Accept</button></footer></body></html>`;

const DARK_PAGE = `<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="font-family:'Courier New',monospace;margin:0;background:#0d1117;color:#e6edf3">
<header style="background:#161b22;padding:18px 28px;font-size:20px;font-weight:600;border-bottom:1px solid #30363d">dark-site.dev</header>
<main style="padding:28px;max-width:760px">
<h1 style="font-size:28px;margin:0 0 12px">Release notes</h1>
<p style="color:#9da7b3;line-height:1.7">Version 2.4 moves the build cache to a shared volume and drops support for Node 18.</p>
<p style="color:#9da7b3;line-height:1.7">Upgrade with the installer, or pull the image tagged 2.4.0.</p>
<button style="padding:10px 16px;font-size:16px">Download</button>
</main></body></html>`;

const HOSTILE_PAGE = LIGHT_PAGE.replace("<head>", `<head><style>
* { color: red !important; font: 30px serif !important; letter-spacing: 4px !important;
    text-transform: uppercase !important; line-height: 3 !important; }
div { display: none !important; opacity: 0.2 !important; }
button { border: 5px solid lime !important; background: yellow !important; }
svg { display: none !important; }
</style>`);

const LOGO = "data:image/png;base64," + fs.readFileSync(path.join(EXT, "icon128.png")).toString("base64");
// The app's colours, taken from tokens.css as engine.js takes them.
const TOKENS = (() => {
  const text = fs.readFileSync(path.join(EXT, "tokens.css"), "utf8");
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(text);
  return block ? block[1].replace(/color-scheme:[^;]*;/, "") : "";
})();

function stub(theme) {
  return `window.chrome = window.chrome || {};
    window.__barListeners = [];
    window.chrome.runtime = { getURL: () => ${JSON.stringify(LOGO)}, sendMessage: (m, cb) => cb && cb({ ok: true }), lastError: null, onMessage: { addListener: (fn) => window.__barListeners.push(fn) } };
    window.chrome.storage = { sync: { get: (key, cb) => setTimeout(() => cb(${JSON.stringify(theme ? { theme } : {})}), 5) }, onChanged: { addListener: () => {} } };`;
}

const STATES = {
  working: { show: true, state: "working", text: "Search for flights from Singapore to Tokyo on 14 November", ended: false },
  needs: { show: true, state: "needs", text: "Waiting for you to sign in", onPage: true, ended: false },
  asks: { show: true, state: "needs", text: "Waiting for your go-ahead", onPage: false, ended: false },
  done: { show: true, state: "done", text: "Done. The answer is on the agent page.", ended: true },
  failed: { show: true, state: "failed", text: "Could not finish. The agent page says why.", ended: true },
};

async function shoot(browser, { name, html, theme, scheme = "light", width = 1280, state = "working", clearOf = null }) {
  const page = await browser.newPage();
  const height = width < 600 ? 640 : 560;
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument(stub(theme));
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html), { waitUntil: "load" });
  await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, "agentBar.js"), "utf8") });
  await page.evaluate((m) => { for (const fn of window.__barListeners) fn(m, {}, () => {}); }, { action: "agentBar", tokens: TOKENS, logo: LOGO, touched: false, ...STATES[state] });
  await new Promise((r) => setTimeout(r, 120));
  // The agent's pointer is about to press at a point under the bar: it moves out of the way.
  if (clearOf) await page.evaluate(() => {
    // A point in the middle of where the bar is drawn now.
    const r = document.getElementById("select-to-ai-agent-bar").getBoundingClientRect();
    for (const fn of window.__barListeners) fn({ action: "agentBarClear", points: [{ x: r.left + r.width / 2, y: r.bottom - 30 }] }, {}, () => {});
  });
  // Let the entrance finish so the shot is the resting state.
  await new Promise((r) => setTimeout(r, 500));
  const file = path.join(OUT, `${name}.png`);
  const top = clearOf ? 0 : height - 240;
  await page.screenshot({ path: file, clip: { x: 0, y: top, width, height: 240 } });
  const box = await page.evaluate(() => { const h = document.getElementById("select-to-ai-agent-bar"); const r = h && h.getBoundingClientRect(); return h ? { w: Math.round(r.width), scrollX: document.documentElement.scrollWidth > innerWidth } : null; });
  console.log(`${name}: bar ${box ? "drawn" : "MISSING"}${box && box.scrollX ? ", page scrolls sideways" : ""}, saved ${path.relative(ROOT, file)}`);
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  for (const width of [1280, 375]) {
    const w = width < 600 ? "narrow" : "desktop";
    await shoot(browser, { name: `${w}-light-page-light-theme`, html: LIGHT_PAGE, theme: "light", scheme: "dark", width });
    await shoot(browser, { name: `${w}-light-page-dark-theme`, html: LIGHT_PAGE, theme: "dark", scheme: "light", width });
    await shoot(browser, { name: `${w}-dark-page-light-theme`, html: DARK_PAGE, theme: "light", scheme: "dark", width });
    await shoot(browser, { name: `${w}-dark-page-dark-theme`, html: DARK_PAGE, theme: "dark", scheme: "light", width });
  }
  for (const state of ["needs", "asks", "done", "failed"]) {
    await shoot(browser, { name: `state-${state}-light`, html: LIGHT_PAGE, theme: "light", state });
    await shoot(browser, { name: `state-${state}-dark`, html: DARK_PAGE, theme: "dark", state });
  }
  // System theme on a page that tries to leak styles in.
  await shoot(browser, { name: "hostile-page-system-theme", html: HOSTILE_PAGE, theme: null, scheme: "dark" });
  // The pointer is about to press under the bar: the bar is at the top instead.
  await shoot(browser, { name: "moved-off-the-pointer", html: LIGHT_PAGE, theme: "light", clearOf: true });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
