"use strict";
// Test-only. In 4.0 the local test server's hosts are optional, so a run on
// them stops at the site-access card, and a test cannot press Chrome's own
// permission prompt. This copies the extension to a temporary folder with
// those hosts added to host_permissions, as if the user had pressed Allow.
// The shipped manifest is never changed. Tests that check the real grants
// (upgrade-from-2.0, worker-no-optional-grants, permission-warning-diff)
// load the build as it is.
//
// With { debugger: true } the copy also gets the debugger permission, for the
// nightly debugger-on suite. 4.0 ships without it (no new warning on update),
// so without this that suite would run a build with no debugger and the
// scenarios that need real input could never pass.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_HOSTS = ["http://127.0.0.1/*", "http://localhost/*"];

function grantedBuild(extDir, hosts = TEST_HOSTS, options = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-granted-"));
  fs.cpSync(extDir, out, { recursive: true });
  const file = path.join(out, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...hosts])];
  if (options.debugger) manifest.permissions = [...new Set([...(manifest.permissions || []), "debugger"])];
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return out;
}

module.exports = { grantedBuild, TEST_HOSTS };
