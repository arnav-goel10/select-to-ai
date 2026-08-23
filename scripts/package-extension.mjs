import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const forbidden = /(^|\/)(\.DS_Store|\.env|.*\.log|.*\.map)$/;

function collectFiles(directory, rootDirectory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolutePath, rootDirectory);
    if (entry.isSymbolicLink()) return [];
    const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join("/");
    return forbidden.test(relativePath) ? [] : [relativePath];
  });
}

export function packageExtension({ extensionRoot, outputPath }) {
  const absoluteExtensionRoot = path.resolve(extensionRoot);
  const absoluteOutputPath = path.resolve(outputPath);
  const files = collectFiles(absoluteExtensionRoot, absoluteExtensionRoot).sort((a, b) => a.localeCompare(b));

  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  fs.rmSync(absoluteOutputPath, { force: true });
  execFileSync("zip", ["-X", "-q", absoluteOutputPath, ...files], {
    cwd: absoluteExtensionRoot,
    stdio: "inherit",
  });
}

/**
 * Packages per browser target. Chromium targets (chrome, edge) share one
 * source tree; each gets its own zip so store uploads stay separate.
 */
export function packageAllTargets({ projectRoot }) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "extension", "manifest.json"), "utf8"),
  );
  const outputs = [];
  for (const target of ["chrome", "edge"]) {
    const outputPath = path.join(projectRoot, "dist", `select-to-ai-${target}.zip`);
    packageExtension({
      extensionRoot: path.join(projectRoot, "extension"),
      outputPath,
    });
    outputs.push({ target, path: outputPath, version: manifest.version });
  }
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const arg = process.argv[2];
  if (arg === "--all") {
    for (const entry of packageAllTargets({ projectRoot })) {
      console.log(`packaged ${entry.target} v${entry.version} -> ${path.relative(projectRoot, entry.path)}`);
    }
  } else {
    packageExtension({
      extensionRoot: path.join(projectRoot, "extension"),
      outputPath: path.join(projectRoot, "dist/select-to-ai-extension.zip"),
    });
    console.log("packaged -> dist/select-to-ai-extension.zip");
  }
}
