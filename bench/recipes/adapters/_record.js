// Helpers shared by the baseline adapters: record what a reference script
// does, and template recorded strings over the task's variables.

export const REFERENCE_API = ["goto", "click", "fill", "selectOption", "check", "uncheck", "textContent", "isVisible"];

export function templatize(str, vars) {
  let out = String(str);
  const entries = Object.entries(vars || {}).filter(([, v]) => String(v).length >= 3).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, value] of entries) out = out.split(String(value)).join(`{${name}}`);
  return out;
}

export function fillTemplate(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? String(vars[name]) : m));
}

// A plain-language description of an element, the way a person writing a
// self-healing test would describe it: accessible name, kind, and the
// dialog or row it sits in (row context only from cells that hold a task
// variable, else the first cell).
// For a read target the element's own text is the value being read, so it is
// described by its label (aria-label, the preceding label text, or the column
// header) instead.
export async function describe(page, selector, vars, reading = false) {
  try {
    return await page.locator(selector).first().evaluate((el, [values, reading]) => {
      const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      const kind = el.getAttribute("role") || { A: "link", BUTTON: "button", SELECT: "dropdown", TEXTAREA: "text area" }[tag] || (tag === "INPUT" ? (type === "checkbox" ? "checkbox" : type === "submit" ? "button" : "field") : "text");
      let name = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.innerText || el.value || "";
      if (tag === "SELECT" && el.labels && el.labels[0]) name = el.labels[0].innerText;
      name = clean(name).slice(0, 60);
      if (reading) {
        name = el.getAttribute("aria-label") || "";
        const cell = el.closest("td");
        if (!name && cell) {
          const table = cell.closest("table");
          const th = table && table.querySelectorAll("thead th")[[...cell.parentElement.children].indexOf(cell)];
          if (th) name = `${clean(th.innerText)} value`;
        }
        if (!name) {
          let prev = el.previousElementSibling;
          if (!prev && el.parentElement) prev = el.parentElement.previousElementSibling;
          if (prev) name = `value shown after "${clean(prev.innerText).replace(/:$/, "").slice(0, 40)}"`;
        }
        if (!name && el.parentElement) name = `value in "${clean(el.parentElement.innerText.replace(el.innerText, "")).slice(0, 40)}"`;
      }
      let where = "";
      const dlg = el.closest("[role=dialog]");
      if (dlg && dlg.getAttribute("aria-label")) where += ` in the "${clean(dlg.getAttribute("aria-label"))}" dialog`;
      const row = el.closest("tr, li");
      if (row) {
        const cells = [...row.children].map((c) => clean(c.innerText)).filter(Boolean);
        const keyed = cells.filter((c) => values.some((v) => v && c.includes(v)));
        where += ` in the row for "${(keyed.length ? keyed : cells.slice(0, 1)).join(" ").slice(0, 80)}"`;
      }
      if (!name && !where) {
        const label = el.closest("dd, td, p, li");
        const prev = label && label.previousElementSibling;
        if (prev) name = `value next to "${clean(prev.innerText).slice(0, 40)}"`;
      }
      return `${name || "element"} ${kind}${where}`.trim();
    }, [Object.values(vars || {}).map(String), reading]);
  } catch {
    return null;
  }
}

// Wrap `page` so a reference run records each call. For calls that take a
// selector, the element description is captured before acting.
export function recordingPage(page, vars, steps) {
  return new Proxy(page, {
    get(target, prop) {
      if (!REFERENCE_API.includes(prop)) return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
      return async (...args) => {
        const step = { op: prop, arg: args[0], value: args[1] };
        if (prop !== "goto" && prop !== "isVisible") step.desc = await describe(target, args[0], vars, prop === "textContent");
        const out = await target[prop](...args);
        if (prop === "textContent") step.result = out;
        if (prop === "isVisible") step.result = out;
        steps.push(step);
        return out;
      };
    },
  });
}

export function recordedTemplates(steps, vars) {
  return steps.map((s) => ({
    op: s.op,
    arg: templatize(s.arg, vars),
    value: s.value == null ? s.value : templatize(s.value, vars),
    desc: s.desc == null ? null : templatize(s.desc, vars),
  }));
}
