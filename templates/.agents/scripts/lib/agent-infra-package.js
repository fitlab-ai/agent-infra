import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@fitlab-ai/agent-infra";
const RUNTIME_RELATIVE_PATH = "runtime/platform-adapters/platform-sync.github.js";
const COMMAND_NAMES = ["ai", "agent-infra"];

function canonicalize(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function inspectPackageRoot(candidate, source) {
  const canonicalRoot = canonicalize(candidate);
  if (!canonicalRoot) {
    return { source, candidate, reason: "path does not exist" };
  }

  const packagePath = path.join(canonicalRoot, "package.json");
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return { source, candidate: canonicalRoot, reason: `cannot read ${packagePath}` };
  }

  if (metadata.name !== PACKAGE_NAME) {
    return {
      source,
      candidate: canonicalRoot,
      reason: `${packagePath} does not belong to ${PACKAGE_NAME}`
    };
  }

  const runtimePath = path.join(canonicalRoot, RUNTIME_RELATIVE_PATH);
  if (!fs.existsSync(runtimePath)) {
    return { source, candidate: canonicalRoot, reason: `runtime not found at ${runtimePath}` };
  }

  return {
    source,
    candidate: canonicalRoot,
    packageRoot: canonicalRoot,
    runtimePath,
    templateRoot: path.join(canonicalRoot, "templates")
  };
}

function packageRootsAbove(startPath) {
  const roots = [];
  let current = path.dirname(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function lookupCommand(command, platform) {
  const lookup = platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    return childProcess.execSync(lookup, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim().split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function rootsForCommand(commandPath, platform) {
  const roots = [];
  if (platform === "win32" && /\.cmd$/i.test(commandPath)) {
    roots.push(path.join(path.dirname(commandPath), "node_modules", "@fitlab-ai", "agent-infra"));
  }

  const canonicalCommand = canonicalize(commandPath);
  if (canonicalCommand) roots.push(...packageRootsAbove(canonicalCommand));
  return roots;
}

function resolveAgentInfraPackage(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const startPath = options.startPath || fileURLToPath(import.meta.url);
  const attempts = [];

  const tryRoot = (candidate, source) => {
    const inspected = inspectPackageRoot(candidate, source);
    attempts.push(inspected);
    return inspected.packageRoot ? inspected : null;
  };

  if (env.AGENT_INFRA_PACKAGE_ROOT) {
    const explicit = tryRoot(env.AGENT_INFRA_PACKAGE_ROOT, "AGENT_INFRA_PACKAGE_ROOT");
    if (explicit) return { ...explicit, attempts };
  }

  for (const candidate of packageRootsAbove(startPath)) {
    const self = tryRoot(candidate, "current installation");
    if (self) return { ...self, attempts };
  }

  for (const command of COMMAND_NAMES) {
    const commandPaths = lookupCommand(command, platform);
    if (commandPaths.length === 0) {
      attempts.push({ source: `PATH:${command}`, candidate: null, reason: "command not found" });
      continue;
    }
    for (const commandPath of commandPaths) {
      const roots = rootsForCommand(commandPath, platform);
      if (roots.length === 0) {
        attempts.push({ source: `PATH:${command}`, candidate: commandPath, reason: "package root not found" });
      }
      for (const candidate of roots) {
        const resolved = tryRoot(candidate, `PATH:${command} (${commandPath})`);
        if (resolved) return { ...resolved, attempts };
      }
    }
  }

  return { packageRoot: null, runtimePath: null, templateRoot: null, attempts };
}

function formatAgentInfraPackageError(result) {
  const details = result.attempts.length > 0
    ? result.attempts.map(({ source, candidate, reason }) =>
      `  - ${source}${candidate ? `: ${candidate}` : ""}: ${reason}`
    ).join("\n")
    : "  - no package candidates were found";
  return [
    "Unable to locate a trusted @fitlab-ai/agent-infra installation.",
    "Attempted package locations:",
    details,
    "Install agent-infra persistently and ensure ai or agent-infra is on PATH:",
    "  npm install -g @fitlab-ai/agent-infra",
    "  brew install fitlab-ai/tap/agent-infra",
    "A one-time npx invocation is only suitable for bootstrap; install before update or validation."
  ].join("\n");
}

export { formatAgentInfraPackageError, resolveAgentInfraPackage };
