import supplier from "./supplier.js";
import admin from "./admin.js";
import reports from "./reports.js";
import orders from "./orders.js";
import wizard from "./wizard.js";
import inventory from "./inventory.js";
import crm from "./crm.js";
import account from "./account.js";

export const APPS = Object.fromEntries([supplier, admin, reports, orders, wizard, inventory, crm, account].map((a) => [a.name, a]));
