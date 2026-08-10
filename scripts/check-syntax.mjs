import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([".git", "node_modules"]);

function collectJavaScript(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (excluded.has(entry)) return [];
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? collectJavaScript(path)
      : /\.(?:js|mjs)$/.test(entry)
        ? [path]
        : [];
  });
}

const files = collectJavaScript(root);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
