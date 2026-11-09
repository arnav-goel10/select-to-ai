// Tasks: goal, typed variables, a hand-written Playwright reference for the
// unmutated app, a truth predicate over the server's state log, and a
// reversibility class.
//
// References may only use: goto, click, fill, selectOption, check, uncheck,
// textContent, isVisible. A read task's reference returns the trimmed result
// of its last textContent call. Pages run in a context whose baseURL is the
// fixture server, so paths are relative.
//
// Truth matchers are (event, vars, T) => boolean with T = {initial, current}
// (per-app state snapshots from GET /__truth).
import { findInvoice } from "../apps/supplier.js";
import { findUser } from "../apps/admin.js";
import { summarize } from "../apps/reports.js";
import { findOrder } from "../apps/orders.js";
import { findItem } from "../apps/inventory.js";
import { findContact } from "../apps/crm.js";
import { findAddress, SETTINGS } from "../apps/account.js";
import { money } from "../lib/ui.js";

const change = (app, entity, test) => (ev, v, T) => ev.kind === "change" && ev.app === app && ev.entity === entity && test(ev, v, T);
const file = (app, test) => (ev, v, T) => ev.kind === "file" && ev.app === app && test(ev, v, T);
const sameObj = (a, b) => Object.keys(b).every((k) => a?.[k] === b[k]);

async function supplierLogin(page) {
  await page.goto("/supplier/login");
  await page.fill("#username", "ap.clerk");
  await page.fill("input[name=password]", "ledger-42");
  await page.click("[data-testid=signin]");
}
async function supplierFilter(page, v) {
  await supplierLogin(page);
  await page.selectOption("#client", v.client);
  await page.selectOption("#month", v.month);
  await page.click("#filter-btn");
}
const invRow = (v) => `//table[@id='invoices']/tbody/tr[td[2]='${v.client}' and td[3]='${v.month}']`;

async function adminOpenUser(page, v) {
  await page.goto("/admin/users");
  await page.fill("#user-search", v.email);
  await page.click("#search-btn");
  await page.click(`//tr[td[@class='email']='${v.email}']//a[contains(@class,'edit-link')]`);
}

async function reportFilter(page, v) {
  await page.goto("/reports/");
  await page.fill("#from", v.from);
  await page.fill("#to", v.to);
  await page.selectOption("#region", v.region);
  await page.click("#apply");
}

async function trackOrder(page, v) {
  await page.goto("/orders/");
  await page.fill("#order-no", v.order);
  await page.fill("#postcode", v.postcode);
  await page.click("#track");
}

async function findSkuPage(page, v) {
  await page.goto("/inventory/items");
  for (let i = 0; i < 12 && !(await page.isVisible(`//table[@id='items']//tr[td[1]='${v.sku}']`)); i++) await page.click("#next-page");
}

async function openContact(page, v) {
  await page.goto("/crm/contacts");
  await page.click(`//ul[@id='contact-list']/li/a[normalize-space()='${v.name}']`);
}

async function accountOpen(page, tab) {
  await page.goto(`/account/${tab}`);
  await page.click("#promo-close");
  await page.click("#cookie-reject");
}

export const TASKS = [
  // ---------------- supplier portal ----------------
  {
    id: "supplier.download",
    app: "supplier",
    goal: "Sign in to the supplier portal (username ap.clerk, password ledger-42) and download the invoice PDF for {client} for {month}.",
    vars: [{ name: "client", type: "string" }, { name: "month", type: "month" }],
    reversibility: "read",
    recordVars: { client: "Northwind Traders", month: "Mar 2026" },
    runVars: [{ client: "Contoso Ltd", month: "Jul 2026" }, { client: "Northwind Trading Co", month: "Mar 2026" }],
    async reference(page, v) {
      await supplierFilter(page, v);
      await page.click(`${invRow(v)}/td[6]/a[2]`);
    },
    truth: { required: [file("supplier", (ev, v, T) => ev.id === findInvoice(T.initial.supplier, v.client, v.month).id)] },
  },
  {
    id: "supplier.amount",
    app: "supplier",
    goal: "Sign in to the supplier portal (username ap.clerk, password ledger-42) and tell me the amount due on the {client} invoice for {month}.",
    vars: [{ name: "client", type: "string" }, { name: "month", type: "month" }],
    reversibility: "read",
    recordVars: { client: "Fabrikam Inc", month: "May 2026" },
    runVars: [{ client: "Contoso Logistics", month: "Feb 2026" }, { client: "Contoso Ltd", month: "May 2026" }],
    async reference(page, v) {
      await supplierFilter(page, v);
      await page.click(`${invRow(v)}//a[@data-testid='view']`);
      return (await page.textContent("#amount")).trim();
    },
    truth: { required: [], witness: (v, T) => findInvoice(T.initial.supplier, v.client, v.month).id, answer: (v, T) => money(findInvoice(T.initial.supplier, v.client, v.month).amount) },
  },
  {
    id: "supplier.dispute",
    app: "supplier",
    goal: "Sign in to the supplier portal (username ap.clerk, password ledger-42) and dispute the {client} invoice for {month} with the reason \"{reason}\".",
    vars: [{ name: "client", type: "string" }, { name: "month", type: "month" }, { name: "reason", type: "text" }],
    reversibility: "commit",
    recordVars: { client: "Northwind Traders", month: "Jun 2026", reason: "Billed twice for the June delivery" },
    runVars: [
      { client: "Fabrikam Inc", month: "Aug 2026", reason: "Unit price differs from contract" },
      { client: "Northwind Trading Co", month: "Jun 2026", reason: "Goods not received" },
    ],
    async reference(page, v) {
      await supplierFilter(page, v);
      await page.click(`${invRow(v)}//a[@data-testid='view']`);
      await page.click("#open-dispute");
      await page.fill("#reason", v.reason);
      await page.click("#dispute-submit");
    },
    truth: {
      required: [change("supplier", "invoice", (ev, v, T) => ev.id === findInvoice(T.initial.supplier, v.client, v.month).id && ev.field === "status" && ev.to === "Disputed" && ev.reason === v.reason)],
    },
  },

  // ---------------- admin console ----------------
  {
    id: "admin.role",
    app: "admin",
    goal: "In the admin console, change the role of {email} to {role}.",
    vars: [{ name: "email", type: "email" }, { name: "role", type: "enum" }],
    reversibility: "commit",
    recordVars: { email: "dana.whitfield@acme.test", role: "Billing admin" },
    runVars: [{ email: "omar.hadad@acme.test", role: "Editor" }, { email: "dana.whitfield@acme-partners.test", role: "Owner" }],
    async reference(page, v) {
      await adminOpenUser(page, v);
      await page.selectOption("#role", v.role);
      await page.click("#save-role");
      await page.click("[data-testid=role-confirm]");
    },
    truth: { required: [change("admin", "user", (ev, v, T) => ev.id === findUser(T.initial.admin, v.email).id && ev.field === "role" && ev.to === v.role)] },
  },
  {
    id: "admin.deactivate",
    app: "admin",
    goal: "In the admin console, deactivate the account {email}.",
    vars: [{ name: "email", type: "email" }],
    reversibility: "commit",
    recordVars: { email: "lena.fischer@acme.test" },
    runVars: [{ email: "lena.fisher@acme.test" }, { email: "sofia.marquez@acme.test" }],
    async reference(page, v) {
      await adminOpenUser(page, v);
      await page.click("#deactivate");
      await page.click("#deactivate-confirm");
    },
    truth: { required: [change("admin", "user", (ev, v, T) => ev.id === findUser(T.initial.admin, v.email).id && ev.field === "status" && ev.to === "Inactive")] },
  },
  {
    id: "admin.lastlogin",
    app: "admin",
    goal: "In the admin console, find when {email} last signed in. Answer with the timestamp shown.",
    vars: [{ name: "email", type: "email" }],
    reversibility: "read",
    recordVars: { email: "kwame.mensah@acme.test" },
    runVars: [{ email: "omar.haddad@acme.test" }, { email: "hiro.tanaka@acme.test" }],
    async reference(page, v) {
      await page.goto("/admin/users");
      await page.click(`//table[@id='users']//tr[td[2]='${v.email}']/td[5]/a`);
      return (await page.textContent("#last-login")).trim();
    },
    truth: { required: [], witness: (v, T) => findUser(T.initial.admin, v.email).id, answer: (v, T) => findUser(T.initial.admin, v.email).lastLogin },
  },

  // ---------------- report export ----------------
  {
    id: "reports.export",
    app: "reports",
    goal: "Export the revenue CSV for the {region} region from {from} to {to}.",
    vars: [{ name: "region", type: "enum" }, { name: "from", type: "date" }, { name: "to", type: "date" }],
    reversibility: "read",
    recordVars: { region: "North", from: "2026-02-01", to: "2026-02-28" },
    runVars: [{ region: "Northeast", from: "2026-03-01", to: "2026-03-31" }, { region: "South", from: "2026-01-15", to: "2026-04-15" }],
    async reference(page, v) {
      await reportFilter(page, v);
      await page.click("[data-testid=export-csv]");
    },
    truth: { required: [file("reports", (ev, v) => ev.id === "report" && sameObj(ev.meta, { region: v.region, from: v.from, to: v.to }))] },
  },
  {
    id: "reports.total",
    app: "reports",
    goal: "What was the total revenue for the {region} region from {from} to {to}?",
    vars: [{ name: "region", type: "enum" }, { name: "from", type: "date" }, { name: "to", type: "date" }],
    reversibility: "read",
    recordVars: { region: "West", from: "2026-04-01", to: "2026-04-30" },
    runVars: [{ region: "East", from: "2026-05-01", to: "2026-06-15" }, { region: "North", from: "2026-04-01", to: "2026-04-30" }],
    async reference(page, v) {
      await reportFilter(page, v);
      return (await page.textContent("#total")).trim();
    },
    truth: { required: [], witness: (v) => `${v.region}|${v.from}|${v.to}`, answer: (v, T) => money(summarize(T.initial.reports, v.region, v.from, v.to).revenue) },
  },
  {
    id: "reports.schedule",
    app: "reports",
    goal: "Create a weekly scheduled export of the {region} region report sent to {email}.",
    vars: [{ name: "region", type: "enum" }, { name: "email", type: "email" }],
    reversibility: "commit",
    recordVars: { region: "East", email: "ops@acme.test" },
    runVars: [{ region: "Northeast", email: "ap.team@acme.test" }, { region: "North", email: "board@acme.test" }],
    async reference(page, v) {
      await page.goto("/reports/schedules");
      await page.fill("#sched-email", v.email);
      await page.selectOption("#sched-region", v.region);
      await page.selectOption("#sched-frequency", "Weekly");
      await page.click("#create-schedule");
    },
    truth: { required: [change("reports", "schedule", (ev, v) => ev.op === "create" && sameObj(ev.to, { email: v.email, region: v.region, frequency: "Weekly" }))] },
  },

  // ---------------- order lookup ----------------
  {
    id: "orders.status",
    app: "orders",
    goal: "Look up order {order} (delivery postcode {postcode}) and tell me its status.",
    vars: [{ name: "order", type: "string" }, { name: "postcode", type: "string" }],
    reversibility: "read",
    recordVars: { order: "SO-48213", postcode: "SW1A 2AA" },
    runVars: [{ order: "SO-50171", postcode: "M1 4BU" }, { order: "SO-83302", postcode: "LS1 5DL" }],
    async reference(page, v) {
      await trackOrder(page, v);
      return (await page.textContent("[data-testid=status]")).trim();
    },
    truth: { required: [], witness: (v) => v.order, answer: (v, T) => findOrder(T.initial.orders, v.order).status },
  },
  {
    id: "orders.tracking",
    app: "orders",
    goal: "Look up order {order} (delivery postcode {postcode}) and give me its tracking number.",
    vars: [{ name: "order", type: "string" }, { name: "postcode", type: "string" }],
    reversibility: "read",
    recordVars: { order: "SO-61904", postcode: "EH1 1YZ" },
    runVars: [{ order: "SO-72251", postcode: "B33 8HT" }, { order: "SO-48231", postcode: "SW1A 2AB" }],
    async reference(page, v) {
      await trackOrder(page, v);
      return (await page.textContent("dd.tracking-no")).trim();
    },
    truth: { required: [], witness: (v) => v.order, answer: (v, T) => findOrder(T.initial.orders, v.order).tracking },
  },
  {
    id: "orders.instructions",
    app: "orders",
    goal: "Set the delivery instructions for order {order} (delivery postcode {postcode}) to \"{note}\".",
    vars: [{ name: "order", type: "string" }, { name: "postcode", type: "string" }, { name: "note", type: "text" }],
    reversibility: "edit",
    recordVars: { order: "SO-72215", postcode: "B33 8TH", note: "Leave with the concierge" },
    runVars: [{ order: "SO-50117", postcode: "M1 4BT", note: "Ring twice, side gate" }, { order: "SO-61940", postcode: "EH1 1ZY", note: "Do not leave in porch" }],
    async reference(page, v) {
      await trackOrder(page, v);
      await page.fill("#instructions", v.note);
      await page.click("#save-instructions");
    },
    truth: { required: [change("orders", "order", (ev, v) => ev.id === v.order && ev.field === "instructions" && ev.to === v.note)] },
  },

  // ---------------- multi-page form ----------------
  {
    id: "wizard.submit",
    app: "wizard",
    goal: "Submit a vendor onboarding application for {company}, tax ID {taxId}, registered in {country}, contact email {email}.",
    vars: [{ name: "company", type: "string" }, { name: "taxId", type: "string" }, { name: "country", type: "enum" }, { name: "email", type: "email" }],
    reversibility: "commit",
    recordVars: { company: "Brightline Freight GmbH", taxId: "DE811907345", country: "Germany", email: "accounts@brightline.test" },
    runVars: [
      { company: "Harbourview Supplies Pte Ltd", taxId: "SG201733119K", country: "Singapore", email: "ap@harbourview.test" },
      { company: "Lowry & Pike LLP", taxId: "GB602114938", country: "United Kingdom", email: "billing@lowrypike.test" },
    ],
    async reference(page, v) {
      await page.goto("/wizard/");
      await page.click("#start");
      await page.fill("#company", v.company);
      await page.fill("#tax-id", v.taxId);
      await page.click("#next-1");
      await page.selectOption("#country", v.country);
      await page.fill("#contact-email", v.email);
      await page.click("#next-2");
      await page.check("#agree");
      await page.click("#submit-application");
    },
    truth: { required: [change("wizard", "application", (ev, v) => ev.op === "create" && sameObj(ev.to, { company: v.company, taxId: v.taxId, country: v.country, email: v.email }))] },
  },
  {
    id: "wizard.draft",
    app: "wizard",
    goal: "Start a vendor onboarding application for {company} with tax ID {taxId} and save it as a draft without submitting.",
    vars: [{ name: "company", type: "string" }, { name: "taxId", type: "string" }],
    reversibility: "edit",
    recordVars: { company: "Orchard Lane Bakery Ltd", taxId: "GB733200981" },
    runVars: [{ company: "Nordlicht Optik AG", taxId: "DE277104553" }, { company: "Tide & Timber BV", taxId: "NL004495112B01" }],
    async reference(page, v) {
      await page.goto("/wizard/");
      await page.click("#start");
      await page.fill("#company", v.company);
      await page.fill("#tax-id", v.taxId);
      await page.click("[data-testid=save-draft]");
    },
    truth: { required: [change("wizard", "draft", (ev, v) => ev.op === "create" && sameObj(ev.to, { company: v.company, taxId: v.taxId }))] },
  },
  {
    id: "wizard.status",
    app: "wizard",
    goal: "What is the status of vendor application {ref}?",
    vars: [{ name: "ref", type: "string" }],
    reversibility: "read",
    recordVars: { ref: "VO-2041" },
    runVars: [{ ref: "VO-3370" }, { ref: "VO-4512" }],
    async reference(page, v) {
      await page.goto("/wizard/");
      await page.fill("#ref-input", v.ref);
      await page.click("#check-status");
      return (await page.textContent("#app-status")).trim();
    },
    truth: { required: [], witness: (v) => v.ref, answer: (v, T) => T.initial.wizard.applications.find((a) => a.ref === v.ref).status },
  },

  // ---------------- paginated table ----------------
  {
    id: "inventory.stock",
    app: "inventory",
    goal: "Set the stock level of {sku} to {qty}.",
    vars: [{ name: "sku", type: "string" }, { name: "qty", type: "integer" }],
    reversibility: "edit",
    recordVars: { sku: "SKU-1042", qty: "137" },
    runVars: [{ sku: "SKU-1042-B", qty: "58" }, { sku: "SKU-1866", qty: "212" }],
    async reference(page, v) {
      await findSkuPage(page, v);
      await page.click(`//table[@id='items']//tr[td[1]='${v.sku}']//a[@data-testid='edit']`);
      await page.fill("#stock", v.qty);
      await page.click("#save-item");
    },
    truth: { required: [change("inventory", "item", (ev, v) => ev.id === v.sku && ev.field === "stock" && ev.to === Number(v.qty))] },
  },
  {
    id: "inventory.reorder",
    app: "inventory",
    goal: "What is the reorder level of {sku}?",
    vars: [{ name: "sku", type: "string" }],
    reversibility: "read",
    recordVars: { sku: "SKU-1130" },
    runVars: [{ sku: "SKU-1737-B" }, { sku: "SKU-1920" }],
    async reference(page, v) {
      await findSkuPage(page, v);
      return (await page.textContent(`//table[@id='items']//tr[td[1]='${v.sku}']/td[4]`)).trim();
    },
    truth: { required: [], witness: (v) => v.sku, answer: (v, T) => String(findItem(T.initial.inventory, v.sku).reorder) },
  },
  {
    id: "inventory.archive",
    app: "inventory",
    goal: "Archive the inventory item {sku}.",
    vars: [{ name: "sku", type: "string" }],
    reversibility: "commit",
    recordVars: { sku: "SKU-1270" },
    runVars: [{ sku: "SKU-1608-B" }, { sku: "SKU-1018" }],
    async reference(page, v) {
      await findSkuPage(page, v);
      await page.click(`//table[@id='items']//tr[td[1]='${v.sku}']//button[@data-testid='archive']`);
      await page.click(`//div[@data-dialog='archive-${v.sku}']//button[@data-testid='archive-confirm']`);
    },
    truth: { required: [change("inventory", "item", (ev, v) => ev.id === v.sku && ev.field === "status" && ev.to === "Archived")] },
  },

  // ---------------- SPA ----------------
  {
    id: "crm.note",
    app: "crm",
    goal: "In the CRM, add the note \"{note}\" to {name}'s contact record.",
    vars: [{ name: "name", type: "string" }, { name: "note", type: "text" }],
    reversibility: "edit",
    recordVars: { name: "Priya Raman", note: "Called, wants a quote by Friday" },
    runVars: [{ name: "Priya Ramanathan", note: "Sent pricing deck" }, { name: "Mei Lin", note: "Follow up after the trade show" }],
    async reference(page, v) {
      await openContact(page, v);
      await page.fill("#note", v.note);
      await page.click("#add-note");
    },
    truth: { required: [change("crm", "contact", (ev, v, T) => ev.id === findContact(T.initial.crm, v.name).id && ev.field === "note" && ev.to === v.note)] },
  },
  {
    id: "crm.phone",
    app: "crm",
    goal: "In the CRM, what is {name}'s phone number?",
    vars: [{ name: "name", type: "string" }],
    reversibility: "read",
    recordVars: { name: "Jonas Berg" },
    runVars: [{ name: "Carla Ruiz" }, { name: "Ade Okafor" }],
    async reference(page, v) {
      await openContact(page, v);
      return (await page.textContent("a.phone")).trim();
    },
    truth: { required: [], witness: (v, T) => findContact(T.initial.crm, v.name).id, answer: (v, T) => findContact(T.initial.crm, v.name).phone },
  },
  {
    id: "crm.stage",
    app: "crm",
    goal: "In the CRM, move {name} to the {stage} stage.",
    vars: [{ name: "name", type: "string" }, { name: "stage", type: "enum" }],
    reversibility: "edit",
    recordVars: { name: "Carlos Ruiz", stage: "Negotiation" },
    runVars: [{ name: "Jonas Bergman", stage: "Won" }, { name: "Mei Ling", stage: "Proposal" }],
    async reference(page, v) {
      await openContact(page, v);
      await page.selectOption("#stage", v.stage);
      await page.click("#update-stage");
    },
    truth: { required: [change("crm", "contact", (ev, v, T) => ev.id === findContact(T.initial.crm, v.name).id && ev.field === "stage" && ev.to === v.stage)] },
  },

  // ---------------- cookie banner + modal ----------------
  {
    id: "account.notify",
    app: "account",
    goal: "In my account settings, turn off {setting} notifications and leave the others as they are.",
    vars: [{ name: "setting", type: "enum" }],
    reversibility: "edit",
    recordVars: { setting: "SMS delivery alerts" },
    runVars: [{ setting: "Product news" }, { setting: "Weekly email digest" }],
    async reference(page, v) {
      await accountOpen(page, "notifications");
      await page.uncheck(`//label[contains(normalize-space(.), '${v.setting}')]/input`);
      await page.click("#save-prefs");
    },
    truth: {
      required: [change("account", "prefs", (ev, v) => ev.field === SETTINGS.find(([, l]) => l === v.setting)[0] && ev.to === false)],
    },
  },
  {
    id: "account.name",
    app: "account",
    goal: "Change my account display name to {name}.",
    vars: [{ name: "name", type: "string" }],
    reversibility: "edit",
    recordVars: { name: "Samira Carter" },
    runVars: [{ name: "S. J. Carter" }, { name: "Sam Carter-Ives" }],
    async reference(page, v) {
      await accountOpen(page, "profile");
      await page.fill("#display-name", v.name);
      await page.click("[data-testid=save-profile]");
    },
    truth: { required: [change("account", "profile", (ev, v) => ev.field === "displayName" && ev.to === v.name)] },
  },
  {
    id: "account.address",
    app: "account",
    goal: "Remove the saved address labelled \"{label}\" from my account.",
    vars: [{ name: "label", type: "string" }],
    reversibility: "commit",
    recordVars: { label: "Office" },
    runVars: [{ label: "Home" }, { label: "Parents" }],
    async reference(page, v) {
      await accountOpen(page, "addresses");
      await page.click(`//tr[td[@class='label']='${v.label}']//button[@data-testid='remove-address']`);
      await page.click(`//tr[td[@class='label']='${v.label}']//button[@data-testid='address-del-confirm']`);
    },
    truth: { required: [change("account", "address", (ev, v, T) => ev.id === findAddress(T.initial.account, v.label).id)] },
  },
];

// The shape an adapter sees (ADAPTER.md): no truth, no reference, no run values.
export const publicTask = (t) => ({ id: t.id, app: t.app, goal: t.goal, vars: t.vars, reversibility: t.reversibility, recordVars: t.recordVars });
