import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function findRepoRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".agents", ".airc.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findSourceCli() {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(current, "bin", "internal-cli.ts");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function configuredWidth(repoRoot) {
  if (!repoRoot) return 2;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agents", ".airc.json"), "utf8"));
    const value = config?.task?.shortIdLength;
    return Number.isInteger(value) && value >= 1 ? value : 2;
  } catch {
    return 2;
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  fs.writeSync(1, "Usage: task-short-id.js <alloc|release|resolve|list> [argument] [--active-dir <path>] [--short-id-length <N>] [--verify]\n");
  process.exit(0);
}
const repoRoot = findRepoRoot(process.cwd());
const forwarded = [...args];
if (!forwarded.includes("--active-dir")) {
  if (!repoRoot) {
    fs.writeSync(2, "Error: cannot determine active task directory\n");
    process.exit(1);
  }
  forwarded.push("--active-dir", path.join(repoRoot, ".agents", "workspace", "active"));
}
if (!forwarded.includes("--short-id-length")) {
  forwarded.push("--short-id-length", String(configuredWidth(repoRoot)));
}
const sourceCli = findSourceCli();
const child = sourceCli
  ? spawnSync(process.execPath, ["--experimental-strip-types", sourceCli, "task-short-id", ...forwarded], { encoding: "utf8" })
  : spawnSync("agent-infra-internal", ["task-short-id", ...forwarded], { encoding: "utf8" });
if (child.error) {
  fs.writeSync(2, `Error: ${child.error.message}\n`);
  process.exit(1);
}
let result;
try {
  result = JSON.parse(child.stdout);
} catch {
  fs.writeSync(2, child.stderr || "Error: invalid task-short-id response\n");
  process.exit(child.status || 1);
}
if (result.output) fs.writeSync(1, `${result.output}${result.output.endsWith("\n") ? "" : "\n"}`);
if (result.status === "failed") {
  if (!result.output) fs.writeSync(2, `Error: ${result.error?.message || "short-id operation failed"}\n`);
  const code = result.error?.code || "";
  process.exit(code.includes("LOCK") ? 3 : /SCHEMA|JSON|DUPLICATE/.test(code) || (code.includes("CAPACITY") && args[0] === "alloc") ? 2 : 1);
}
