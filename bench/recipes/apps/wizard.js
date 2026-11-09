// Vendor onboarding: a multi-page application form with drafts, a review
// page, and a status lookup.
import { h } from "../lib/h.js";
import { page, pick } from "../lib/ui.js";

export const COUNTRIES = ["Germany", "France", "Ireland", "Netherlands", "Singapore", "United Kingdom", "United States"];
const REFS = ["VO-2041", "VO-2014", "VO-3307", "VO-3370", "VO-4512", "VO-4521", "VO-5806", "VO-5860"];
export const APP_STATUSES = ["Received", "In review", "Needs information", "Approved", "Rejected"];

function seed(rng) {
  return {
    applications: REFS.map((ref) => ({ ref, company: `Vendor ${ref.slice(3)}`, status: pick(rng, APP_STATUSES) })),
    work: {},
    drafts: [],
    next: 7001,
  };
}

const shell = (ctx, title, body) => ({ tree: page({ title: `${title} - Vendor onboarding`, brand: "Vendor Onboarding", nav: [[`${ctx.base}/`, "Home", "nav-home"]], body }) });
const steps = (n, total) => h("p", { class: "muted step-count", _k: "step-count" }, `Step ${n} of ${total}`);

function home(ctx, ref) {
  const a = ref && ctx.state.applications.find((x) => x.ref === ref.trim().toUpperCase());
  return shell(ctx, "Home", [
    h("h1", { _k: "home-title" }, "Vendor onboarding"),
    h("p", { _k: "start-row" }, h("a", { href: `${ctx.base}/step1`, class: "btn primary", id: "start", "data-testid": "start", _k: "start" }, "Start new application")),
    h(
      "form",
      { method: "get", action: `${ctx.base}/status`, class: "card", _k: "status-form" },
      h("label", { for: "ref-input", _k: "ref-label" }, "Application reference"),
      h("input", { id: "ref-input", name: "ref", value: ref || "", _k: "ref-input" }),
      " ",
      h("button", { type: "submit", class: "btn", id: "check-status", _k: "check-status" }, "Check status"),
    ),
    ref && (a ? h("p", { class: "card", _k: "status-result" }, h("span", { _k: "app-status-label" }, "Status: "), h("strong", { id: "app-status", class: "app-status", "data-testid": "app-status", _k: "app-status" }, a.status)) : h("p", { class: "error" }, "No application with that reference.")),
  ]);
}

function step1(ctx, error) {
  const w = ctx.state.work;
  const extra = ctx.flags.extraField;
  const split = ctx.flags.splitStep;
  return shell(ctx, "Company details", [
    h("h1", { _k: "step1-title" }, "Company details"),
    steps(1, split ? 4 : 3),
    error && h("p", { class: "error", role: "alert" }, error),
    h(
      "form",
      { id: "step1-form", method: "post", action: `${ctx.base}/step1`, class: "card", _k: "step1-form" },
      h("label", { for: "company", _k: "company-label" }, "Legal company name"),
      h("input", { id: "company", name: "company", value: w.company || "", _k: "company" }),
      h("label", { for: "tax-id", _k: "tax-label" }, "Tax ID"),
      h("input", { id: "tax-id", name: "taxId", value: w.taxId || "", _k: "tax-id" }),
      extra && [h("label", { for: "extra", _k: "extra-label" }, extra.label), h("select", { id: "extra", name: "extra", required: true, _k: "extra" }, h("option", { value: "" }, "Choose..."), extra.options.map((o) => h("option", { value: o, selected: o === extra.default }, o)))],
      h(
        "p",
        { class: "row-actions", _k: "step1-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/discard`, id: "discard", _k: "discard" }, "Discard"),
        h("button", { type: "submit", class: "btn", formaction: `${ctx.base}/save-draft`, id: "save-draft", "data-testid": "save-draft", _k: "save-draft" }, "Save draft"),
        h("button", { type: "submit", class: "btn primary", id: "next-1", "data-testid": "next", _k: "next-1" }, "Next"),
      ),
    ),
  ]);
}

function step2(ctx, part) {
  const w = ctx.state.work;
  const split = ctx.flags.splitStep;
  const showCountry = !split || part === "a";
  const showEmail = !split || part === "b";
  return shell(ctx, "Contact", [
    h("h1", { _k: "step2-title" }, split ? (showCountry ? "Location" : "Contact") : "Location and contact"),
    steps(split && part === "b" ? 3 : 2, split ? 4 : 3),
    h(
      "form",
      { id: "step2-form", method: "post", action: `${ctx.base}/step2${split ? part : ""}`, class: "card", _k: "step2-form" },
      showCountry && [h("label", { for: "country", _k: "country-label" }, "Country of registration"), h("select", { id: "country", name: "country", _k: "country" }, h("option", { value: "" }, "Choose..."), COUNTRIES.map((c) => h("option", { value: c, selected: c === w.country }, c)))],
      showEmail && [h("label", { for: "contact-email", _k: "email-label" }, "Contact email"), h("input", { id: "contact-email", name: "email", type: "email", value: w.email || "", _k: "contact-email" })],
      h(
        "p",
        { class: "row-actions", _k: "step2-actions" },
        h("a", { href: `${ctx.base}/step1`, class: "btn", id: "back-2", _k: "back-2" }, "Back"),
        h("button", { type: "submit", class: "btn primary", id: "next-2", "data-testid": "next", _k: "next-2" }, "Next"),
      ),
    ),
  ]);
}

function review(ctx, error) {
  const w = ctx.state.work;
  const extra = ctx.flags.extraField;
  const split = ctx.flags.splitStep;
  return shell(ctx, "Review", [
    h("h1", { _k: "review-title" }, "Review and submit"),
    steps(split ? 4 : 3, split ? 4 : 3),
    error && h("p", { class: "error", role: "alert" }, error),
    h(
      "dl",
      { class: "card", _k: "review-facts" },
      h("dt", {}, "Company"), h("dd", { id: "r-company" }, w.company || ""),
      h("dt", {}, "Tax ID"), h("dd", { id: "r-tax" }, w.taxId || ""),
      h("dt", {}, "Country"), h("dd", { id: "r-country" }, w.country || ""),
      h("dt", {}, "Contact"), h("dd", { id: "r-email" }, w.email || ""),
      extra && [h("dt", {}, extra.label), h("dd", {}, w.extra || "")],
    ),
    h(
      "form",
      { id: "submit-form", method: "post", action: `${ctx.base}/submit`, class: "card", _k: "submit-form" },
      h("label", { class: "check", _k: "agree-label" }, h("input", { type: "checkbox", id: "agree", name: "agree", value: "yes", _k: "agree" }), " I confirm these details are correct"),
      h(
        "p",
        { class: "row-actions", _k: "submit-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/cancel`, id: "cancel-application", _k: "cancel-application" }, "Cancel application"),
        h("button", { type: "submit", class: "btn primary", id: "submit-application", "data-testid": "submit", _k: "submit-application" }, "Submit application"),
      ),
    ),
  ]);
}

export default {
  name: "wizard",
  title: "Vendor onboarding (multi-page form)",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    const w = ctx.state.work;
    const post = ctx.method === "POST";
    const extra = ctx.flags.extraField;
    if (p === "/") return home(ctx, null);
    if (p === "/status") return { ...home(ctx, ctx.query.ref || ""), shows: [(ctx.query.ref || "").trim().toUpperCase()] };
    if (p === "/step1" && !post) return step1(ctx);
    if (p === "/step1" && post) {
      if (extra && !ctx.form.extra) {
        ctx.log("fail", { what: "step1-missing-extra" });
        return step1(ctx, `${extra.label} is required.`);
      }
      Object.assign(w, { company: ctx.form.company || "", taxId: ctx.form.taxId || "", ...(extra ? { extra: ctx.form.extra } : {}) });
      ctx.log("ui", { what: "step1", ...w });
      return { redirect: `${ctx.base}/${ctx.flags.splitStep ? "step2a" : "step2"}` };
    }
    if (p === "/save-draft" && post) {
      const d = { id: `d${ctx.state.drafts.length + 1}`, company: ctx.form.company || "", taxId: ctx.form.taxId || "", ...(extra ? { extra: ctx.form.extra || "" } : {}) };
      ctx.state.drafts.push(d);
      ctx.change("draft", d.id, "created", null, { company: d.company, taxId: d.taxId }, { op: "create" });
      return { redirect: `${ctx.base}/?saved=1` };
    }
    if (p === "/discard" && post) {
      ctx.change("draft", "work", "discarded", false, true, { op: "discard" });
      ctx.state.work = {};
      return { redirect: `${ctx.base}/` };
    }
    if (/^\/step2[ab]?$/.test(p)) {
      const part = p.slice(6) || (ctx.flags.splitStep ? "a" : "");
      if (!post) return step2(ctx, part);
      if (ctx.form.country != null) w.country = ctx.form.country;
      if (ctx.form.email != null) w.email = ctx.form.email;
      ctx.log("ui", { what: `step2${part}` });
      return { redirect: `${ctx.base}/${ctx.flags.splitStep && part === "a" ? "step2b" : "review"}` };
    }
    if (p === "/review") return review(ctx);
    if (p === "/cancel" && post) {
      ctx.change("application", "work", "cancelled", false, true, { op: "cancel" });
      ctx.state.work = {};
      return { redirect: `${ctx.base}/` };
    }
    if (p === "/submit" && post) {
      if (ctx.form.agree !== "yes") {
        ctx.log("fail", { what: "submit-no-agree" });
        return review(ctx, "Please confirm the details are correct.");
      }
      const ref = `VO-${ctx.state.next++}`;
      const a = { ref, company: w.company || "", taxId: w.taxId || "", country: w.country || "", email: w.email || "", status: "Received", ...(w.extra ? { extra: w.extra } : {}) };
      ctx.state.applications.push(a);
      ctx.change("application", ref, "created", null, { company: a.company, taxId: a.taxId, country: a.country, email: a.email, ...(a.extra ? { extra: a.extra } : {}) }, { op: "create" });
      ctx.state.work = {};
      return { redirect: `${ctx.base}/done?ref=${ref}` };
    }
    if (p === "/done") return shell(ctx, "Submitted", [h("h1", {}, "Application submitted"), h("p", { class: "flash" }, `Your reference is ${ctx.query.ref}.`)]);
    return null;
  },
};
