import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));

function filePath(relativePath: string): string {
  const directPath = path.join(rootDir, relativePath);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  if (relativePath.endsWith(".js")) {
    const tsPath = path.join(rootDir, `${relativePath.slice(0, -3)}.ts`);
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }
  return directPath;
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
  read
};
