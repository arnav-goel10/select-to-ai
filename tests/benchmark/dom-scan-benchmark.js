/**
 * Measures the cost of the agent's interactive-element scan on a realistic
 * page, in a real Chrome. Compares the current traversal against an optimised
 * one so the difference is evidence rather than assertion.
 *
 * Run: node tests/benchmark/dom-scan-benchmark.js
 */
const puppeteer = require("puppeteer");

// A page shaped like a real app: deep nesting, many inert wrappers, a
// realistic minority of genuinely interactive controls.
const PAGE = `<!doctype html><html><body>
<nav id=nav></nav><main id=main></main><footer id=foot></footer>
<script>
function fill(host, cards) {
  let html = "";
  for (let i = 0; i < cards; i++) {
    html += '<div class=card><div class=inner><div class=meta>'
      + '<span>label ' + i + '</span><span>meta ' + i + '</span><em>tag</em>'
      + '</div><div class=body><p>Body copy for card ' + i + ' with some text.</p>'
      + '<p>Second paragraph of card ' + i + '.</p></div>'
      + '<div class=actions><a href="#' + i + '">Open item ' + i + '</a>'
      + '<button type=button>Save ' + i + '</button></div></div></div>';
  }
  host.innerHTML = html;
}
fill(document.getElementById('main'), 300);
fill(document.getElementById('nav'), 30);
fill(document.getElementById('foot'), 30);
const f = document.createElement('form');
f.innerHTML = '<input type=text placeholder=Search><input type=email placeholder=Email>'
  + '<textarea></textarea><select><option>a</option></select><button type=submit>Go</button>';
document.getElementById('main').prepend(f);
<\/script></body></html>`;

const INTERACTIVE_TAGS = ["a","button","input","select","textarea","summary","label","option"];
const INTERACTIVE_ROLES = ["button","link","checkbox","radio","tab","menuitem","textbox","combobox","switch","option"];

async function main() {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(PAGE), { waitUntil: "load" });

  const result = await page.evaluate(
    (tags, roles) => {
      const TAGS = new Set(tags), ROLES = new Set(roles);
      const total = document.querySelectorAll("*").length;

      // Instrument getComputedStyle so the call count is measured, not guessed.
      const realGCS = window.getComputedStyle.bind(window);
      let gcsCalls = 0;
      window.getComputedStyle = function (...args) { gcsCalls++; return realGCS(...args); };

      // ---- CURRENT: computed style on every non-interactive element -------
      function currentCollect(root, list = []) {
        root.querySelectorAll("*").forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          if (TAGS.has(tag) || (role && ROLES.has(role)) || el.hasAttribute("tabindex") || el.isContentEditable) {
            list.push(el);
          } else {
            try { const s = window.getComputedStyle(el); if (s && s.cursor === "pointer") list.push(el); } catch (_) {}
          }
          if (el.shadowRoot) currentCollect(el.shadowRoot, list);
        });
        return list;
      }

      gcsCalls = 0;
      let t0 = performance.now();
      const curr = currentCollect(document);
      const currentMs = performance.now() - t0;
      const currentGcs = gcsCalls;

      // ---- OPTIMISED: cheap structural pass first, computed style only for
      // the small set of plausible click targets ---------------------------
      function optimisedCollect(root, list = []) {
        root.querySelectorAll("*").forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          if (TAGS.has(tag) || (role && ROLES.has(role)) || el.hasAttribute("tabindex") || el.isContentEditable) {
            list.push(el); 
          } else if (
            // Only elements that could plausibly be a custom control are worth
            // a style read: they carry a click-ish hint or a handler attribute.
            el.hasAttribute("onclick") ||
            el.hasAttribute("data-testid") ||
            el.className && typeof el.className === "string" &&
              /(^|[\s_-])(btn|button|clickable|link|action|tab|menu|toggle|card)([\s_-]|$)/i.test(el.className)
          ) {
            try { const s = window.getComputedStyle(el); if (s && s.cursor === "pointer") list.push(el); } catch (_) {}
          }
          if (el.shadowRoot) optimisedCollect(el.shadowRoot, list);
        });
        return list;
      }

      gcsCalls = 0;
      t0 = performance.now();
      const opt = optimisedCollect(document);
      const optimisedMs = performance.now() - t0;
      const optimisedGcs = gcsCalls;

      window.getComputedStyle = realGCS;
      return {
        totalElements: total,
        current: { ms: +currentMs.toFixed(1), gcs: currentGcs, found: curr.length },
        optimised: { ms: +optimisedMs.toFixed(1), gcs: optimisedGcs, found: opt.length },
      };
    },
    INTERACTIVE_TAGS,
    INTERACTIVE_ROLES,
  );

  await browser.close();
  const speedup = (result.current.ms / Math.max(result.optimised.ms, 0.01)).toFixed(1);
  console.log(JSON.stringify({ ...result, speedup: speedup + "x" }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
