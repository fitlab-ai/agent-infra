#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distLib = path.join(rootDir, "dist", "lib");

function hashFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(rootDir, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function resolveExecutableFiles(entries) {
  const pending = [...entries];
  const resolved = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (resolved.has(relative)) continue;
    resolved.add(relative);
    if (!/\.[cm]?[jt]s$/u.test(relative)) continue;
    const file = path.join(rootDir, relative);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/gu)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const dependency = [base, `${base}.ts`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.js")]
        .find((candidate) => fs.existsSync(candidate) && fs.lstatSync(candidate).isFile());
      if (!dependency) throw new Error(`Lifecycle executable dependency '${match[1]}' from '${relative}' is unavailable`);
      const dependencyRelative = path.relative(rootDir, dependency);
      if (dependencyRelative.startsWith("..") || path.isAbsolute(dependencyRelative)) {
        throw new Error(`Lifecycle executable dependency '${match[1]}' escapes the package root`);
      }
      pending.push(dependencyRelative);
    }
  }
  return [...resolved].sort();
}

const lifecycleFiles = JSON.parse(fs.readFileSync(
  path.join(rootDir, "lib", "agent-clients", "adapters", "codex-lifecycle", "manifest-files.json"),
  "utf8"
));
const packageVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
const compiledExecutableFiles = lifecycleFiles.executableFiles.map((file) =>
  file.endsWith(".ts") ? path.join("dist", file.replace(/\.ts$/u, ".js")) : file
);
fs.writeFileSync(path.join(rootDir, "dist", "lifecycle-build-manifest.json"), `${JSON.stringify({
  protocolVersion: 3,
  packageVersion,
  sourceInputHash: hashFiles(resolveExecutableFiles(lifecycleFiles.executableFiles)),
  internalExecutableBuildHash: hashFiles(resolveExecutableFiles(compiledExecutableFiles))
}, null, 2)}\n`);
process.stdout.write("Generated dist/lifecycle-build-manifest.json\n");

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

const agentClientRuntimesSrc = path.join(rootDir, "lib", "agent-clients", "adapters", "runtimes");
const agentClientRuntimesDst = path.join(distLib, "agent-clients", "adapters", "runtimes");
for (const file of fs.readdirSync(agentClientRuntimesSrc)) {
  if (file.endsWith(".dockerfile")) {
    copyFile(path.join(agentClientRuntimesSrc, file), path.join(agentClientRuntimesDst, file));
  }
}

for (const file of ["cli.js", "internal-cli.js"]) {
  try {
    fs.chmodSync(path.join(rootDir, "dist", "bin", file), 0o755);
    process.stdout.write(`Chmod 0755 dist/bin/${file}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`chmod skipped for dist/bin/${file}: ${message}\n`);
  }
}
