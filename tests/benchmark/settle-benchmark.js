/**
 * Measures the post-action settle wait, which runs after every agent action.
 * Compares the current implementation against the proposed one on three
 * realistic pages: a static page, a page with a CSS animation, and a page
 * that genuinely re-renders after a click.
 *
 * Run: node tests/benchmark/settle-benchmark.js
 */
const puppeteer = require("puppeteer");

const PAGES = {
  static: `<!doctype html><body><h1>Static</h1><p>Nothing mutates here.</p></body>`,
  animated: `<!doctype html><body><h1>Animated</h1><div id=t>0</div>
    <script>setInterval(()=>{const d=document.getElementById('t');
      d.style.opacity=(Math.random()*0.5+0.5).toFixed(3);
      d.textContent=String(Date.now()%1000);},50)<\/script></body>`,
  reactive: `<!doctype html><body><h1>Reactive</h1><div id=out></div>
    <script>setTimeout(()=>{document.getElementById('out').innerHTML='<p>loaded</p>';},220)<\/script></body>`,
};

const CURRENT = `function waitForDomStable(quietPeriod, timeout) {
  return new Promise((resolve) => {
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { observer.disconnect(); resolve(); }, quietPeriod);
    });
    observer.observe(document.body, { childList:true, subtree:true, attributes:true, characterData:true });
    debounce = setTimeout(() => { observer.disconnect(); resolve(); }, quietPeriod);
    setTimeout(() => { observer.disconnect(); clearTimeout(debounce); resolve(); }, timeout);
  });
}`;

const PROPOSED = [
  'function waitForDomStable(quietPeriod, timeout) {',
  '  return new Promise((resolve) => {',
  '    const POLL_MS = 100;',
  '    const STABLE_SAMPLES = 2;',
  '    const started = Date.now();',
  '    let last = null, stable = 0;',
  '    const signature = () => {',
  '      let count = 0, total = 0;',
  '      try { count = document.querySelectorAll(',
  '        \'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]\'',
  '      ).length; total = document.querySelectorAll("*").length; } catch (_) {}',
  '      return location.href + "|" + document.title + "|" + count + "|" + total + "|" + Math.round(window.scrollY || 0);',
  '    };',
  '    const tick = () => {',
  '      const now = signature();',
  '      if (now === last) stable++; else { stable = 0; last = now; }',
  '      const elapsed = Date.now() - started;',
'      // Never settle sooner than the quiet period: async content that has',
'      // not landed yet would be invisible to the signature. The gain is at',
'      // the other end, where mutation-quiet used to burn the hard timeout.',
'      if ((stable >= STABLE_SAMPLES && elapsed >= quietPeriod) || elapsed >= timeout) return resolve();',
  '      setTimeout(tick, POLL_MS);',
  '    };',
  '    last = signature();',
  '    setTimeout(tick, POLL_MS);',
  '  });',
  '}',
].join("\n");

async function measure(page, html, impl, quiet, timeout) {
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html), { waitUntil: "load" });
  return page.evaluate(async (implSrc, q, t) => {
    eval(implSrc);
    const t0 = performance.now();
    await waitForDomStable(q, t);
    // Correctness gate: on the reactive page the late content MUST be present
    // when the wait resolves. Without this, settling instantly always "wins".
    const out = document.getElementById("out");
    const sawLateContent = out ? out.textContent.includes("loaded") : null;
    return { ms: Math.round(performance.now() - t0), sawLateContent };
  }, impl, quiet, timeout);
}

async function main() {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  const out = {};
  const failures = [];
  for (const [name, html] of Object.entries(PAGES)) {
    const cur = await measure(page, html, CURRENT, 350, 2200);
    const pro = await measure(page, html, PROPOSED, 350, 2200);
    out[name] = {
      currentMs: cur.ms,
      proposedMs: pro.ms,
      savedMs: cur.ms - pro.ms,
      correct: pro.sawLateContent === null ? "n/a" : pro.sawLateContent,
    };
    if (pro.sawLateContent === false) failures.push(name + ": settled before late content arrived");
  }
  await browser.close();
  const totalSaved = Object.values(out).reduce((a, r) => a + r.savedMs, 0);
  const avgSaved = Math.round(totalSaved / Object.keys(out).length);
  console.log(JSON.stringify({ perAction: out, avgSavedMsPerAction: avgSaved,
    savedOver25Steps: (avgSaved * 25 / 1000).toFixed(1) + "s",
    correctness: failures.length ? failures : "all pages settled after their content" }, null, 2));
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
