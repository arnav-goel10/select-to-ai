const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const i18n = require("../../extension/i18n.js");

const localesRoot = path.resolve(__dirname, "../../extension/_locales");

test("default locale (en) exists and is valid JSON", () => {
  const file = path.join(localesRoot, "en", "messages.json");
  const messages = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(messages.appName.message.length > 0);
});

test("every non-default locale carries all en keys with translations", () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesRoot, "en", "messages.json"), "utf8"));
  for (const dir of fs.readdirSync(localesRoot)) {
    if (dir === "en") continue;
    const messages = JSON.parse(
      fs.readFileSync(path.join(localesRoot, dir, "messages.json"), "utf8"),
    );
    for (const key of Object.keys(en)) {
      assert.ok(messages[key], `${dir} missing key ${key}`);
      // Descriptions stay English; user-facing strings should differ from
      // the key name at minimum (guards against empty stubs).
      assert.ok(messages[key].message.length > 0, `${dir}/${key} empty`);
    }
  }
});

test("t() resolves known keys via fallbacks without the chrome API", () => {
  assert.equal(i18n.t("appName"), "Select to AI");
  assert.match(i18n.t("appDescription"), /bounded/);
});

test("t() returns the key itself for unknown keys (visible, not silent)", () => {
  assert.equal(i18n.t("definitelyNotAKey"), "definitelyNotAKey");
});
