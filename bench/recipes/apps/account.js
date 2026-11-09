// Account settings behind a cookie banner and a promotional modal:
// notification preferences, display name, saved addresses.
import { h } from "../lib/h.js";
import { page, confirmDialog } from "../lib/ui.js";

export const SETTINGS = [
  ["emailDigest", "Weekly email digest"],
  ["smsAlerts", "SMS delivery alerts"],
  ["productNews", "Product news"],
  ["partnerOffers", "Partner offers"],
];

function seed() {
  return {
    profile: { displayName: "Sam Carter" },
    prefs: { emailDigest: true, smsAlerts: true, productNews: true, partnerOffers: true },
    addresses: [
      { id: "a1", label: "Home (old)", line: "14 Elm Row, Leeds" },
      { id: "a2", label: "Home", line: "3 Quay Street, Leeds" },
      { id: "a3", label: "Office", line: "1 Park Square, Leeds" },
      { id: "a4", label: "Office annex", line: "2 Park Square, Leeds" },
      { id: "a5", label: "Parents", line: "77 Mill Lane, York" },
    ],
  };
}

export const findAddress = (state, label) => state.addresses.find((a) => a.label === label);

function overlays(ctx) {
  return [
    h(
      "div",
      { "data-overlay": "", "data-once": "consent", class: "bar", role: "dialog", "aria-label": "Cookie preferences", _k: "cookie-banner" },
      h(
        "div",
        { class: "dlg" },
        h("p", { _k: "cookie-text" }, "We use cookies to keep you signed in and, with your permission, to measure how the site is used."),
        h(
          "div",
          { class: "actions", _k: "cookie-actions" },
          h("button", { type: "button", class: "btn", "data-dismiss": "essential", id: "cookie-reject", _k: "cookie-reject" }, "Essential only"),
          h("button", { type: "button", class: "btn primary", "data-dismiss": "all", id: "cookie-accept", _k: "cookie-accept" }, "Accept all"),
        ),
      ),
    ),
    h(
      "div",
      { "data-overlay": "", "data-once": "promo-autumn", "data-delay": String(ctx.flags.promoDelay ?? 400), role: "dialog", "aria-label": "Try Premium", _k: "promo" },
      h(
        "div",
        { class: "dlg" },
        h("h3", { _k: "promo-title" }, "Try Premium free for 30 days"),
        h("p", {}, "Faster delivery, no fees."),
        h(
          "div",
          { class: "actions", _k: "promo-actions" },
          h("button", { type: "button", class: "btn", "data-dismiss": "", id: "promo-close", _k: "promo-close" }, "No thanks"),
          h("a", { class: "btn primary", href: `${ctx.base}/premium`, id: "promo-cta", _k: "promo-cta" }, "Start free trial"),
        ),
      ),
    ),
  ];
}

function shell(ctx, title, tab, body, flash) {
  const tabs = [["profile", "Profile"], ["notifications", "Notifications"], ["addresses", "Addresses"]];
  return {
    tree: page({
      title: `${title} - My account`,
      brand: "My account",
      nav: [[`${ctx.base}/profile`, "Settings", "nav-settings"]],
      body: [
        h("nav", { class: "tabs", _k: "tabs" }, tabs.map(([t, l]) => h("a", { href: `${ctx.base}/${t}`, class: `tab${t === tab ? " active" : ""}`, id: `tab-${t}`, "aria-current": t === tab ? "page" : null, _k: `tab-${t}` }, l))),
        flash && h("p", { class: "flash", role: "status" }, flash),
        body,
        overlays(ctx),
      ],
    }),
  };
}

function profile(ctx, flash) {
  return shell(
    ctx,
    "Profile",
    "profile",
    h(
      "form",
      { method: "post", action: `${ctx.base}/profile`, class: "card", _k: "profile-form" },
      h("label", { for: "display-name", _k: "name-label" }, "Display name"),
      h("input", { id: "display-name", name: "displayName", value: ctx.state.profile.displayName, _k: "display-name" }),
      h("p", { _k: "profile-actions" }, h("button", { type: "submit", class: "btn primary", id: "save-profile", "data-testid": "save-profile", _k: "save-profile" }, "Save profile")),
    ),
    flash,
  );
}

function notifications(ctx, flash) {
  return shell(
    ctx,
    "Notifications",
    "notifications",
    h(
      "form",
      { method: "post", action: `${ctx.base}/notifications`, class: "card", _k: "prefs-form" },
      h("input", { type: "hidden", name: "_sent", value: "1" }),
      SETTINGS.map(([key, label]) =>
        h("p", { class: "pref", _k: `pref-${key}` }, h("label", { class: "check", _k: `pref-label-${key}` }, h("input", { type: "checkbox", id: `pref-${key}`, name: key, value: "on", checked: ctx.state.prefs[key], _k: `pref-input-${key}` }), ` ${label}`)),
      ),
      h(
        "p",
        { class: "row-actions", _k: "prefs-actions" },
        h("button", { type: "submit", class: "btn danger", formaction: `${ctx.base}/notifications/off`, id: "all-off", _k: "all-off" }, "Turn off all notifications"),
        h("button", { type: "submit", class: "btn primary", id: "save-prefs", "data-testid": "save-prefs", _k: "save-prefs" }, "Save preferences"),
      ),
    ),
    flash,
  );
}

function addresses(ctx, flash) {
  return shell(
    ctx,
    "Addresses",
    "addresses",
    [
      h(
        "table",
        { id: "addresses", class: "card", _k: "address-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Label"), h("th", {}, "Address"), h("th", {}, ""))),
        h(
          "tbody",
          {},
          ctx.state.addresses.map((a) =>
            h(
              "tr",
              { class: "address-row" },
              h("td", { class: "label" }, a.label),
              h("td", {}, a.line),
              h("td", { class: "row-actions", _k: "address-actions" }, h("a", { href: `${ctx.base}/addresses/${a.id}`, class: "btn", _k: "address-edit" }, "Edit"), h("button", { type: "button", class: "btn danger", "data-open": `del-${a.id}`, "data-testid": "remove-address", _k: "address-remove" }, "Remove"), h("form", { id: `del-form-${a.id}`, method: "post", action: `${ctx.base}/addresses/${a.id}/delete` }), confirmDialog({ name: `del-${a.id}`, k: "address-del", title: "Remove address?", text: `${a.label}: ${a.line}`, confirmLabel: "Remove", formId: `del-form-${a.id}` })),
            ),
          ),
        ),
      ),
    ],
    flash,
  );
}

export default {
  name: "account",
  title: "Account settings with cookie banner and modal",
  seed,
  async handle(ctx) {
    const p = ctx.path;
    const post = ctx.method === "POST";
    const done = ctx.query.done ? "Saved." : null;
    if (p === "/" || p === "/premium") return { redirect: `${ctx.base}/profile` };
    if (p === "/profile" && !post) return profile(ctx, done);
    if (p === "/profile") {
      const next = (ctx.form.displayName || "").trim();
      if (next && next !== ctx.state.profile.displayName) {
        ctx.change("profile", "me", "displayName", ctx.state.profile.displayName, next);
        ctx.state.profile.displayName = next;
      }
      return { redirect: `${ctx.base}/profile?done=1` };
    }
    if (p === "/notifications" && !post) return notifications(ctx, done);
    if (p === "/notifications") {
      for (const [key] of SETTINGS) {
        const v = ctx.form[key] === "on";
        if (v !== ctx.state.prefs[key]) {
          ctx.change("prefs", "me", key, ctx.state.prefs[key], v);
          ctx.state.prefs[key] = v;
        }
      }
      return { redirect: `${ctx.base}/notifications?done=1` };
    }
    if (p === "/notifications/off" && post) {
      for (const [key] of SETTINGS) {
        if (ctx.state.prefs[key]) ctx.change("prefs", "me", key, true, false);
        ctx.state.prefs[key] = false;
      }
      return { redirect: `${ctx.base}/notifications?done=1` };
    }
    if (p === "/addresses") return addresses(ctx, done);
    const m = p.match(/^\/addresses\/(a\d+)(\/delete)?$/);
    const a = m && ctx.state.addresses.find((x) => x.id === m[1]);
    if (!a) return { redirect: `${ctx.base}/addresses` };
    if (m[2] && post) {
      ctx.change("address", a.id, "deleted", false, true, { label: a.label });
      ctx.state.addresses = ctx.state.addresses.filter((x) => x !== a);
      return { redirect: `${ctx.base}/addresses?done=1` };
    }
    return addresses(ctx, null);
  },
};
