import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRootDir = fileURLToPath(new URL("../..", import.meta.url));
const compiled = path.basename(runtimeRootDir) === "dist";
const projectRootDir = compiled ? path.dirname(runtimeRootDir) : runtimeRootDir;

function filePath(relativePath: string): string {
  const directPath = path.join(projectRootDir, relativePath);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  if (relativePath.endsWith(".js")) {
    const tsPath = path.join(projectRootDir, `${relativePath.slice(0, -3)}.ts`);
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }
  return directPath;
}

function modulePath(relativePath: string): string {
  if (!compiled) return filePath(relativePath);
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("lib/") || normalized.startsWith("bin/")) {
    const compiledRelativePath = normalized.endsWith(".ts")
      ? `${normalized.slice(0, -3)}.js`
      : normalized;
    if (compiledRelativePath.endsWith(".js")) {
      return path.join(projectRootDir, "dist", compiledRelativePath);
    }
  }
  return filePath(relativePath);
}

function exists(relativePath: string): boolean {
  return fs.existsSync(filePath(relativePath));
}

function read(relativePath: string): string {
  return fs.readFileSync(filePath(relativePath), "utf8");
}

function listFilesRecursive(relativeDir: string): string[] {
  const entries = fs.readdirSync(filePath(relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(relativePath);
    }
    return [relativePath];
  });
}

function listSkillNames(): string[] {
  return fs.readdirSync(filePath(".agents/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export {
  exists,
  filePath,
  listFilesRecursive,
  listSkillNames,
  modulePath,
  read
};
