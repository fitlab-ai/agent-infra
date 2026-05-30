#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distLib = path.join(rootDir, "dist", "lib");

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  process.stdout.write(`Copied ${path.relative(rootDir, dst)}\n`);
}

copyFile(
  path.join(rootDir, "lib", "defaults.json"),
  path.join(distLib, "defaults.json")
);

const runtimesSrc = path.join(rootDir, "lib", "sandbox", "runtimes");
const runtimesDst = path.join(distLib, "sandbox", "runtimes");
for (const file of fs.readdirSync(runtimesSrc)) {
  if (file.endsWith(".dockerfile")) {
    copyFile(path.join(runtimesSrc, file), path.join(runtimesDst, file));
  }
}

try {
  fs.chmodSync(path.join(rootDir, "dist", "bin", "cli.js"), 0o755);
  process.stdout.write("Chmod 0755 dist/bin/cli.js\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`chmod skipped: ${message}\n`);
}
