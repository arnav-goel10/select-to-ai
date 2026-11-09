const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../../extension");
const validatorUrl = pathToFileURL(path.resolve(__dirname, "../../scripts/validate-manifest.mjs"));

async function loadValidator() {
  try {
    return await import(validatorUrl.href);
  } catch (error) {
    assert.fail(`manifest validator should load: ${error.message}`);
  }
}

test("repository manifest is valid and all entrypoints exist", async () => {
  const { validateManifest } = await loadValidator();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(validateManifest(manifest, root), []);
});

test("validator rejects unrestricted host access", async () => {
  const { validateManifest } = await loadValidator();
  const errors = validateManifest({ manifest_version: 3, host_permissions: ["<all_urls>"] }, root);
  assert.ok(errors.includes("host_permissions must not contain <all_urls>"));
});

test("validator rejects a declared entrypoint that does not exist", async () => {
  const { validateManifest } = await loadValidator();
  const errors = validateManifest(
    { manifest_version: 3, background: { service_worker: "missing.js" } },
    root,
  );
  assert.ok(errors.includes("declared entrypoint does not exist: missing.js"));
});

test("public description is plain, short and matches the store listing", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.doesNotMatch(manifest.description, /autonomous/i);
  assert.ok(manifest.description.length <= 132, "the store truncates summaries over 132 characters");
  const listing = fs.readFileSync(path.join(root, "..", "docs", "store-listing.md"), "utf8");
  assert.ok(listing.includes(manifest.description), "manifest and store listing summaries differ");
});
