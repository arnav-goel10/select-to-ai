// CRM single-page app: client-side routing over server-rendered fragments.
// Contacts list, contact detail (phone, stage), notes.
import { h } from "../lib/h.js";
import { page, int } from "../lib/ui.js";

export const STAGES = ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"];
const NAMES = ["Priya Raman", "Priya Ramanathan", "Jonas Berg", "Jonas Bergman", "Mei Lin", "Mei Ling", "Carlos Ruiz", "Carla Ruiz", "Ada Okafor", "Ade Okafor"];

function seed(rng) {
  return {
    contacts: NAMES.map((name, i) => ({
      id: `c${201 + i}`,
      name,
      company: ["Globex", "Initech", "Umbrella", "Hooli", "Vandelay"][i % 5],
      phone: `+44 20 ${int(rng, 1000, 9999)} ${int(rng, 1000, 9999)}`,
      stage: STAGES[i % 4],
      notes: [],
    })),
  };
}

export const findContact = (state, name) => state.contacts.find((c) => c.name === name);

function listView(ctx) {
  return [
    h("h1", { _k: "contacts-title" }, "Contacts"),
    h(
      "ul",
      { class: "card contact-list", id: "contact-list", _k: "contact-list" },
      ctx.state.contacts.map((c) =>
        h("li", { class: "contact-item", _k: "contact-item" }, h("a", { href: `${ctx.base}/contacts/${c.id}`, "data-link": "", class: "contact-link", _k: "contact-link" }, c.name), " ", h("span", { class: "muted" }, c.company)),
      ),
    ),
  ];
}

function detailView(ctx, c, flash) {
  return [
    h("p", {}, h("a", { href: `${ctx.base}/contacts`, "data-link": "", _k: "back" }, "All contacts")),
    flash && h("p", { class: "flash", role: "status" }, flash),
    h("h1", { id: "contact-name", _k: "contact-name" }, c.name),
    h(
      "div",
      { class: "card", _k: "contact-card" },
      h("p", {}, "Company: ", h("span", {}, c.company)),
      h("p", { _k: "phone-row" }, h("span", { _k: "phone-label" }, "Phone: "), h("a", { id: "phone", class: "phone", href: `tel:${c.phone.replace(/ /g, "")}`, "data-testid": "phone", _k: "phone" }, c.phone)),
    ),
    h(
      "form",
      { "data-spa-form": "", method: "post", action: `${ctx.base}/contacts/${c.id}/stage`, class: "card", _k: "stage-form" },
      h("label", { for: "stage", _k: "stage-label" }, "Pipeline stage"),
      h("select", { id: "stage", name: "stage", _k: "stage" }, [...(ctx.flags.stages || STAGES), ...((ctx.flags.stages || STAGES).includes(c.stage) ? [] : [c.stage])].map((s) => h("option", { value: s, selected: s === c.stage }, s))),
      " ",
      h("button", { type: "submit", class: "btn primary", id: "update-stage", "data-testid": "update-stage", _k: "update-stage" }, "Update stage"),
    ),
    h(
      "form",
      { "data-spa-form": "", method: "post", action: `${ctx.base}/contacts/${c.id}/notes`, class: "card", _k: "note-form" },
      h("label", { for: "note", _k: "note-label" }, "New note"),
      h("textarea", { id: "note", name: "note", rows: 3, _k: "note" }),
      h(
        "p",
        { class: "row-actions", _k: "note-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/contacts/${c.id}/delete`, id: "delete-contact", _k: "delete-contact" }, "Delete contact"),
        h("button", { type: "submit", class: "btn primary", id: "add-note", "data-testid": "add-note", _k: "add-note" }, "Add note"),
      ),
      h("ul", { id: "notes", _k: "notes" }, c.notes.map((n) => h("li", {}, n))),
    ),
  ];
}

export default {
  name: "crm",
  title: "CRM single-page app",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (ctx.flags.duplicateContacts && !ctx.state.duplicated) {
      // A CRM import created a second record for every person.
      ctx.state.duplicated = true;
      const twins = ctx.state.contacts.map((c, i) => ({ ...c, id: `c${301 + i}`, company: `${c.company} (imported)`, phone: c.phone.replace(/\d$/, (d) => String((Number(d) + 3) % 10)), notes: [] }));
      ctx.state.contacts = ctx.state.contacts.flatMap((c, i) => [twins[i], c]);
    }
    const view = (body, url) =>
      ctx.fragment ? { tree: h("div", {}, ...body), fragment: true, spaUrl: url } : { tree: page({ title: "CRM", brand: "Pipeline CRM", nav: [[`${ctx.base}/contacts`, "Contacts", "nav-contacts"]], body, spa: true }) };
    // Fragments render inside the SPA root, so the tree root is a bare div.
    if (p === "/" || p === "/contacts") return view(listView(ctx), `${ctx.base}/contacts`);
    const m = p.match(/^\/contacts\/(c\d+)(?:\/(stage|notes|delete))?$/);
    const c = m && ctx.state.contacts.find((x) => x.id === m[1]);
    if (!c) return { status: 404, text: "No such contact" };
    if (!m[2] || ctx.method !== "POST") return { ...view(detailView(ctx, c), `${ctx.base}/contacts/${c.id}`), shows: [c.id] };
    if (m[2] === "stage") {
      const to = ctx.form.stage || c.stage;
      if (to !== c.stage) ctx.change("contact", c.id, "stage", c.stage, to);
      c.stage = to;
      return view(detailView(ctx, c, "Stage updated."), `${ctx.base}/contacts/${c.id}`);
    }
    if (m[2] === "notes") {
      const note = (ctx.form.note || "").trim();
      if (note) {
        c.notes.push(note);
        ctx.change("contact", c.id, "note", null, note, { op: "create" });
      }
      return view(detailView(ctx, c, "Note added."), `${ctx.base}/contacts/${c.id}`);
    }
    ctx.change("contact", c.id, "deleted", false, true);
    ctx.state.contacts = ctx.state.contacts.filter((x) => x !== c);
    return view(listView(ctx), `${ctx.base}/contacts`);
  },
};
