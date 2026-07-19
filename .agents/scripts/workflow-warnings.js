import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function usage() {
  process.stderr.write([
    "Usage:",
    "  node .agents/scripts/workflow-warnings.js add <task-dir> --step <step> --severity <IMPORTANT|ACTION_REQUIRED> --code <code> --target <target> --message <message> --action <action> [--dry-run]",
    "  node .agents/scripts/workflow-warnings.js set-status <task-dir> --id <WW-N> --status <resolved|ignored> --resolution <reason> [--dry-run]",
    "  node .agents/scripts/workflow-warnings.js list <task-dir> [--status <status>] [--format json|text]",
    ""
  ].join("\n"));
  process.exit(2);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--dry-run") { options["dry-run"] = true; continue; }
    if (!key?.startsWith("--")) usage();
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) usage();
    if (Object.hasOwn(options, key.slice(2))) usage();
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function warningShape(warning) {
  if (!warning) return null;
  return {
    id: warning.id, time: warning.time, step: warning.step, severity: warning.severity,
    code: warning.code, status: warning.status, target: warning.target,
    message: warning.message, action: warning.action,
    resolved_at: warning.resolvedAt, resolution: warning.resolution
  };
}

function invoke(taskRef, command, options) {
  const args = ["task-warning", taskRef, command];
  const ignored = new Set(["format"]);
  for (const [key, value] of Object.entries(options)) {
    if (ignored.has(key)) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  const child = spawnSync("agent-infra-internal", args, { encoding: "utf8", shell: false });
  if (child.error?.code === "ENOENT") {
    throw new Error("agent-infra-internal not found on PATH. Install agent-infra globally or ensure the internal CLI is available.");
  }
  if (child.error) throw child.error;
  let result;
  try { result = JSON.parse(child.stdout || "{}"); }
  catch { throw new Error(child.stderr || "task-warning returned invalid JSON"); }
  if (child.status !== 0 || result.status === "failed") {
    throw new Error(result.error?.message || child.stderr || "task-warning failed");
  }
  return result;
}

try {
  const [command, taskDirArg, ...rest] = process.argv.slice(2);
  if (!command || !taskDirArg || !["add", "set-status", "list"].includes(command)) usage();
  const taskRef = path.basename(path.resolve(taskDirArg));
  const options = parseOptions(rest);
  const result = invoke(taskRef, command, options);
  if (command === "list") {
    const warnings = result.warnings.map(warningShape);
    if ((options.format || "text") === "json") process.stdout.write(`${JSON.stringify({ warnings }, null, 2)}\n`);
    else if ((options.format || "text") === "text") {
      for (const warning of warnings) process.stdout.write(`${warning.id} [${warning.severity}] ${warning.code} ${warning.target} - ${warning.action}\n`);
    } else usage();
  } else if (command === "add") {
    process.stdout.write(`${JSON.stringify({ created: !result.before && result.changed, updated: Boolean(result.before && result.changed), warning: warningShape(result.after) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ updated: result.changed, warning: warningShape(result.after) }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
