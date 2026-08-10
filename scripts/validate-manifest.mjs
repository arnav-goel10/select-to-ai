import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateManifest(manifest, extensionRoot) {
  const errors = [];
  if (manifest.manifest_version !== 3) errors.push("manifest_version must equal 3");
  if ((manifest.host_permissions ?? []).includes("<all_urls>")) {
    errors.push("host_permissions must not contain <all_urls>");
  }
  const files = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.side_panel?.default_path,
    ...(manifest.declarative_net_request?.rule_resources ?? []).map((entry) => entry.path),
    ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ].filter(Boolean);
  for (const relativePath of files) {
    if (!fs.existsSync(path.join(extensionRoot, relativePath))) {
      errors.push(`declared entrypoint does not exist: ${relativePath}`);
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const extensionRoot = path.resolve("extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
  const errors = validateManifest(manifest, extensionRoot);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
