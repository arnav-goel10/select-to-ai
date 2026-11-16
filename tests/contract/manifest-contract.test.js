// The 4.0 manifest contract (plan: manifest-contract). Each rule is its own
// test so a red run names exactly what would prompt or disable a 2.0 user.
//
//   node --test tests/contract/manifest-contract.test.js
//
// MANIFEST_DIR points it at another tree, for example the unzipped package.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "../..");
const extensionDir = process.env.MANIFEST_DIR ? path.resolve(process.env.MANIFEST_DIR) : path.join(projectRoot, "extension");
const contractUrl = pathToFileURL(path.join(projectRoot, "scripts/check-manifest.mjs")).href;

const load = async () => {
  const contract = await import(contractUrl);
  return { contract, inputs: contract.loadInputs(projectRoot, extensionDir) };
};

test("the contract rejects what the 2.0 users must not be asked for", async () => {
  const { contract } = await load();
  const bad = {
    permissions: ["storage", "debugger", "notifications", "favicon"],
    host_permissions: ["https://chatgpt.com/*", "https://claude.ai/*"],
    content_scripts: [{ matches: ["https://perplexity.ai/*"] }],
    omnibox: { keyword: "ai" },
    version: "4.0.0",
  };
  assert.equal(contract.checkPermissions(bad).length, 3);
  assert.equal(contract.checkNamedPermissions(bad).length, 2);
  assert.equal(contract.checkHosts(bad).length, 1);
  assert.equal(contract.checkContentScriptMatches(bad).length, 1);
  assert.equal(contract.checkOmnibox(bad).length, 1);
  assert.equal(contract.checkMinimumChrome(bad).length, 1);
  assert.equal(contract.checkVersions({ manifest: bad, packageJson: { version: "4.0.0" }, changelog: "# Changelog\n\n## 4.0.1 - 2026-11-20\n" }).length, 1);
});

test("the contract accepts the target manifest shape", async () => {
  const { contract } = await load();
  const good = {
    permissions: [...contract.ALLOWED_PERMISSIONS],
    optional_permissions: ["notifications"],
    host_permissions: [...contract.ALLOWED_HOSTS],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_scripts: [{ matches: [...contract.ALLOWED_HOSTS] }],
    minimum_chrome_version: "120",
    version: "4.0.0",
  };
  for (const { rule, problems } of contract.checkAll({ manifest: good, packageJson: { version: "4.0.0" }, changelog: "## 4.0.0 - 2026-11-20\n" })) {
    assert.deepEqual(problems, [], rule);
  }
});

test("shipped manifest holds every rule", async (t) => {
  const { contract, inputs } = await load();
  for (const { rule, problems } of contract.checkAll(inputs)) {
    await t.test(rule, () => {
      assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
    });
  }
});
