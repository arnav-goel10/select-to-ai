// Admin console: search users, change a role, deactivate, read last login.
import { h } from "../lib/h.js";
import { page, confirmDialog, int, pick } from "../lib/ui.js";

export const ROLES = ["Viewer", "Editor", "Billing admin", "Owner"];
const PEOPLE = [
  ["Dana Whitfield", "dana.whitfield@acme.test"],
  ["Dana Whitfield", "dana.whitfield@acme-partners.test"],
  ["Omar Haddad", "omar.haddad@acme.test"],
  ["Omar Hadad", "omar.hadad@acme.test"],
  ["Lena Fischer", "lena.fischer@acme.test"],
  ["Lena Fisher", "lena.fisher@acme.test"],
  ["Kwame Mensah", "kwame.mensah@acme.test"],
  ["Sofia Marquez", "sofia.marquez@acme.test"],
  ["Sofia Marques", "sofia.marques@acme.test"],
  ["Hiro Tanaka", "hiro.tanaka@acme.test"],
  ["Aisha Bello", "aisha.bello@acme.test"],
  ["Tom Becker", "tom.becker@acme.test"],
];

export const findUser = (state, email) => state.users.find((u) => u.email === email);

function seed(rng) {
  const users = PEOPLE.map(([name, email], i) => ({
    id: `u${101 + i}`,
    name,
    email,
    role: ROLES[i % 3],
    status: "Active",
    lastLogin: `2026-${String(int(rng, 7, 10)).padStart(2, "0")}-${String(int(rng, 1, 28)).padStart(2, "0")} ${String(int(rng, 7, 19)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}`,
  }));
  return { users };
}

const shell = (ctx, title, body) => ({
  tree: page({ title: `${title} - Admin`, brand: "Acme Admin", nav: [[`${ctx.base}/users`, "Users", "nav-users"], [`${ctx.base}/audit`, "Audit log", "nav-audit"]], body }),
});

function list(ctx) {
  const q = (ctx.query.q || "").toLowerCase().trim();
  const rows = ctx.state.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  return shell(ctx, "Users", [
    h("h1", { _k: "users-title" }, "Users"),
    h(
      "form",
      { method: "get", action: `${ctx.base}/users`, class: "card search", role: "search", _k: "search-form" },
      h("label", { for: "user-search", _k: "search-label" }, "Search users"),
      h("input", { id: "user-search", name: "q", value: ctx.query.q || "", placeholder: "Name or email", _k: "search-input" }),
      " ",
      h("button", { type: "submit", class: "btn", id: "search-btn", _k: "search-btn" }, "Search"),
    ),
    h(
      "table",
      { id: "users", class: "users-table", _k: "users-table" },
      h("thead", {}, h("tr", {}, ["Name", "Email", "Role", "Status", ""].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        rows.map((u) =>
          h(
            "tr",
            { class: "user-row", "data-user": u.id },
            h("td", {}, u.name),
            h("td", { class: "email" }, u.email),
            h("td", {}, u.role),
            h("td", {}, u.status),
            h(
              "td",
              { class: "row-actions", _k: "row-actions" },
              h("form", { method: "post", action: `${ctx.base}/users/${u.id}/delete`, _k: "row-delete-form" }, h("button", { class: "btn danger", "data-testid": "delete-user", _k: "row-delete" }, "Delete")),
              h("a", { href: `${ctx.base}/users/${u.id}`, class: "btn edit-link", "data-testid": "edit-user", _k: "row-edit" }, "Edit"),
            ),
          ),
        ),
      ),
    ),
  ]);
}

function detail(ctx, u, flash) {
  const roles = ctx.flags.roles || ROLES;
  return shell(ctx, u.name, [
    h("p", {}, h("a", { href: `${ctx.base}/users`, _k: "back" }, "All users")),
    flash && h("p", { class: "flash", role: "status" }, flash),
    h("h1", { _k: "user-title" }, u.name),
    h(
      "div",
      { class: "card", _k: "profile-card" },
      h("p", {}, "Email: ", h("span", { id: "user-email" }, u.email)),
      h("p", { _k: "last-login-row" }, h("span", { _k: "last-login-label" }, "Last sign-in: "), h("time", { id: "last-login", class: "last-login", "data-testid": "last-login", _k: "last-login" }, u.lastLogin)),
      h("p", {}, "Status: ", h("span", { id: "user-status" }, u.status)),
    ),
    h(
      "form",
      { id: "role-form", method: "post", action: `${ctx.base}/users/${u.id}/role`, class: "card", _k: "role-form" },
      h("label", { for: "role", _k: "role-label" }, "Role"),
      h("select", { id: "role", name: "role", _k: "role-select" }, roles.map((r) => h("option", { value: r, selected: r === u.role, _k: `role-opt-${r}` }, r))),
      h(
        "p",
        { class: "row-actions", _k: "role-actions" },
        h("button", { type: "button", class: "btn primary", id: "save-role", "data-open": "role", "data-testid": "save-role", _k: "save-role" }, "Save role"),
        h("button", { type: "submit", class: "btn", id: "reset-password", formaction: `${ctx.base}/users/${u.id}/reset`, _k: "reset-password" }, "Send password reset"),
      ),
    ),
    confirmDialog({ name: "role", title: "Change role?", text: `${u.name} will get the selected role immediately.`, confirmLabel: "Confirm", formId: "role-form" }),
    h(
      "form",
      { id: "status-form", method: "post", action: `${ctx.base}/users/${u.id}/deactivate`, class: "card", _k: "status-card" },
      h("h3", {}, "Account"),
      h(
        "p",
        { class: "row-actions", _k: "status-actions" },
        h("button", { type: "submit", class: "btn danger", id: "delete-user", formaction: `${ctx.base}/users/${u.id}/delete`, _k: "delete-user" }, "Delete user"),
        h("button", { type: "button", class: "btn", id: "deactivate", "data-open": "deactivate", "data-testid": "deactivate", _k: "deactivate" }, "Deactivate user"),
      ),
    ),
    confirmDialog({ name: "deactivate", title: "Deactivate user?", text: `${u.name} will be signed out and unable to sign in.`, confirmLabel: "Deactivate", formId: "status-form" }),
  ]);
}

export default {
  name: "admin",
  title: "Admin console",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    if (p === "/" || p === "/audit") return { redirect: `${ctx.base}/users` };
    if (p === "/users") return list(ctx);
    const m = p.match(/^\/users\/(u\d+)(?:\/(role|deactivate|delete|reset))?$/);
    const u = m && ctx.state.users.find((x) => x.id === m[1]);
    if (!u) return { status: 404, text: "No such user" };
    if (!m[2]) return { ...detail(ctx, u, ctx.query.done ? "Saved." : null), shows: [u.id] };
    if (ctx.method !== "POST") return { redirect: `${ctx.base}/users/${u.id}` };
    if (m[2] === "role") {
      if (ctx.form.role !== u.role) ctx.change("user", u.id, "role", u.role, ctx.form.role);
      u.role = ctx.form.role;
    } else if (m[2] === "deactivate") {
      ctx.change("user", u.id, "status", u.status, "Inactive");
      u.status = "Inactive";
    } else if (m[2] === "reset") {
      ctx.change("user", u.id, "passwordReset", null, "sent");
    } else if (m[2] === "delete") {
      ctx.change("user", u.id, "deleted", false, true);
      ctx.state.users = ctx.state.users.filter((x) => x !== u);
      return { redirect: `${ctx.base}/users` };
    }
    return { redirect: `${ctx.base}/users/${u.id}?done=1` };
  },
};
