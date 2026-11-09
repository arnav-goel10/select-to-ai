const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "../..");
const extensionRoot = path.join(projectRoot, "extension");
const packagerUrl = pathToFileURL(path.join(projectRoot, "scripts/package-extension.mjs")).href;

async function loadPackager() {
  try {
    return await import(packagerUrl);
  } catch (error) {
    assert.fail(`extension packager should load: ${error.message}`);
  }
}

test("packager creates a metadata-stripped archive rooted at manifest.json", async () => {
  const { packageExtension } = await loadPackager();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "select-to-ai-package-"));
  const outputPath = path.join(tempRoot, "select-to-ai-extension.zip");
  try {
    packageExtension({ extensionRoot, outputPath });
    const entries = execFileSync("unzip", ["-Z1", outputPath], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.ok(entries.includes("manifest.json"));
    assert.ok(entries.includes("background.js"));
    assert.equal(entries.some((entry) => entry.startsWith("extension/")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("extension tree contains no local or secret files", () => {
  const forbidden = /(^|\/)(\.DS_Store|\.env|.*\.log|.*\.map)$/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [path.relative(extensionRoot, absolute)];
  });
  assert.deepEqual(walk(extensionRoot).filter((name) => forbidden.test(name)), []);
});

test("packager excludes symbolic links that could escape the extension tree", async () => {
  const { packageExtension } = await loadPackager();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "select-to-ai-package-link-"));
  const fixtureRoot = path.join(tempRoot, "extension");
  const secretPath = path.join(tempRoot, "secret.txt");
  const outputPath = path.join(tempRoot, "select-to-ai-extension.zip");
  fs.mkdirSync(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, "manifest.json"), "{}");
  fs.writeFileSync(secretPath, "secret");
  fs.symlinkSync(secretPath, path.join(fixtureRoot, "secret-link.txt"));
  try {
    packageExtension({ extensionRoot: fixtureRoot, outputPath });
    const entries = execFileSync("unzip", ["-Z1", outputPath], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(entries.includes("secret-link.txt"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("packager leaves out Chrome's _metadata folder, which the Web Store refuses", async () => {
  const { packageExtension } = await loadPackager();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "select-to-ai-package-meta-"));
  const fixtureRoot = path.join(tempRoot, "extension");
  const outputPath = path.join(tempRoot, "select-to-ai-extension.zip");
  fs.mkdirSync(path.join(fixtureRoot, "_metadata", "generated_indexed_rulesets"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "manifest.json"), "{}");
  fs.writeFileSync(path.join(fixtureRoot, "_metadata", "generated_indexed_rulesets", "_ruleset1"), "x");
  try {
    packageExtension({ extensionRoot: fixtureRoot, outputPath });
    const entries = execFileSync("unzip", ["-Z1", outputPath], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(entries, ["manifest.json"]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the repository and the store package carry no internal planning or application material", () => {
  // Drafts, strategy research and planning notes lived on private
  // branches; the public tree and the zip must not carry them again.
  const internal = /(^|\/)(yc[-_]|morning-brief|launch-posts|design-partners|NAMING\.md$|research\/)|(^|\/)docs\/(site|research)\//i;
  const walk = (dir, base) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") return [];
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute, base) : [path.relative(base, absolute).split(path.sep).join("/")];
  });
  assert.deepEqual(walk(projectRoot, projectRoot).filter((name) => internal.test(name)), []);
  // Only what Chrome runs goes in the zip: no notes, no docs.
  assert.deepEqual(walk(extensionRoot, extensionRoot).filter((name) => !/\.(js|json|html|css|png|svg)$/.test(name)), []);
});
