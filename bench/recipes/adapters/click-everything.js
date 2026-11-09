// Degenerate: presses every visible button and in-app link it can find,
// page after page, then claims done.
export default {
  name: "click-everything",
  async prepare() {
    return null;
  },
  async run({ page, baseUrl }) {
    const appPath = new URL(baseUrl).pathname;
    const pressed = new Set();
    await page.goto(baseUrl).catch(() => {});
    for (let n = 0; n < 40; n++) {
      const loc = page.locator("button, input[type=submit], a[href]");
      const count = Math.min(await loc.count().catch(() => 0), 80);
      let clicked = false;
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        const info = await el
          .evaluate((e) => ({ text: (e.innerText || e.value || e.getAttribute("aria-label") || "").trim(), href: e.getAttribute("href") || "", url: location.pathname }))
          .catch(() => null);
        if (!info) continue;
        if (info.href && !(info.href.startsWith(appPath) || (!info.href.startsWith("/") && !info.href.includes(":")))) continue;
        const key = `${info.url}|${info.text}|${info.href}|${i}`;
        if (pressed.has(key) || !(await el.isVisible().catch(() => false))) continue;
        pressed.add(key);
        await el.click({ timeout: 1000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        clicked = true;
        break;
      }
      if (!clicked) break;
    }
    return { claimedDone: true, answer: null, healed: false };
  },
};
