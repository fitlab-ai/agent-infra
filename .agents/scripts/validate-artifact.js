import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_CODE = {
  pass: 0,
  fail: 1,
  blocked: 2
};

const TASK_ENUMS = {
  type: ["feature", "bugfix", "refactor", "docs", "chore"],
  workflow: ["feature-development", "bug-fix", "refactoring"],
  status: ["active", "blocked", "completed"]
};

const DEFAULT_REQUIRED_FIELDS = [
  "id",
  "type",
  "workflow",
  "status",
  "created_at",
  "updated_at",
  "current_step",
  "assigned_to"
];

const DEFAULT_RETRY_DELAYS_MS = [3000, 10000];
const DEFAULT_FRESHNESS_MINUTES = 30;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?$/;
const ACTIVITY_LOG_PATTERN = /^- (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?) — \*\*(.+?)\*\* by (.+?) — (.+)$/;
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

const PLATFORM_ADAPTERS = {};
const OPTIONAL_PLATFORM_CHECKS = new Set(["platform-sync"]);
const adaptersDir = path.join(path.dirname(scriptPath), "platform-adapters");

if (fs.existsSync(adaptersDir)) {
  for (const file of fs.readdirSync(adaptersDir)) {
    if (!file.endsWith(".js")) {
      continue;
    }

    const adapterName = path.basename(file, ".js");
    const mod = await import(new URL(`./platform-adapters/${file}`, import.meta.url));
    if (typeof mod.check === "function") {
      PLATFORM_ADAPTERS[adapterName] = mod.check;
    }
  }
}

const sharedUtils = {
  loadTask,
  getCheckedRequirements,
  normalizeContent,
  isBlank,
  escapeRegExp,
  passResult,
  failResult,
  blockedResult,
  safeStat,
  parseIssueNumber,
  parsePrNumber,
  repoRoot
};

// === CLI Entry ===

function main(argv) {
  const [mode, ...rest] = argv;

  if (mode === "gate") {
    runGate(rest);
    return;
  }

  if (mode === "check") {
    runSingleCheck(rest);
    return;
  }

  printUsageAndExit();
}

function runGate(args) {
  const { value: formatValue, rest: positional } = extractOption(args, "--format");
  const format = normalizeFormat(formatValue);
  const [skillName, taskDirArg, artifactFile] = positional;

  if (!skillName || !taskDirArg) {
    printUsageAndExit();
  }

  const taskDir = path.resolve(taskDirArg);
  const verifyConfig = loadVerifyConfig(skillName);
  const checks = [];

  for (const [type, checkConfig] of Object.entries(verifyConfig.checks || {})) {
    if (checkConfig === null) {
      continue;
    }

    const result = runCheck(type, {
      skillName,
      taskDir,
      artifactFile,
      config: checkConfig
    });

    checks.push(result);

    if (result.status === "blocked") {
      break;
    }
  }

  const gate = summarizeGate(checks);
  const output = {
    gate,
    skill: skillName,
    checks,
    summary: summarizeChecks(checks),
    action: buildAction(gate, checks)
  };

  writeOutput(output, format);
  process.exit(EXIT_CODE[gate]);
}

function runSingleCheck(args) {
  const { value: formatValue, rest: formatArgs } = extractOption(args, "--format");
  const format = normalizeFormat(formatValue);
  const { value: skillName, rest: positional } = extractOption(formatArgs, "--skill");

  if (!skillName) {
    printUsageAndExit();
  }

  const [type, taskDirArg, artifactFile] = positional;

  if (!type || !taskDirArg) {
    printUsageAndExit();
  }

  const verifyConfig = loadVerifyConfig(skillName);
  const config = (verifyConfig.checks || {})[type];

  if (config === undefined) {
    failUsage(`Unknown check type '${type}' for skill '${skillName}'.`);
  }

  if (config === null) {
    writeOutput({
      type,
      skill: skillName,
      status: "pass",
      message: `Check '${type}' is disabled for skill '${skillName}'.`
    }, format);
    process.exit(0);
  }

  const result = runCheck(type, {
    skillName,
    taskDir: path.resolve(taskDirArg),
    artifactFile,
    config
  });

  writeOutput({
    skill: skillName,
    ...result
  }, format);
  process.exit(EXIT_CODE[result.status] ?? 1);
}

function runCheck(type, context) {
  switch (type) {
    case "task-meta":
      return checkTaskMeta(context);
    case "artifact":
      return checkArtifact(context);
    case "activity-log":
      return checkActivityLog(context);
    case "completion-checklist":
      return checkCompletionChecklist(context);
    default: {
      const adapter = PLATFORM_ADAPTERS[type];
      if (!adapter) {
        if (OPTIONAL_PLATFORM_CHECKS.has(type)) {
          return passResult(type, `Skipped: no platform adapter registered for '${type}'`);
        }

        return failResult(type, `Unsupported check type '${type}'.`);
      }

      return adapter(context, sharedUtils);
    }
  }
}

// === Check Implementations ===

function checkTaskMeta({ taskDir, config }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("task-meta", task.message);
  }

  const metadata = task.metadata;
  const requiredFields = config.required_fields || DEFAULT_REQUIRED_FIELDS;
  const missingFields = requiredFields.filter((field) => isBlank(metadata[field]));
  if (missingFields.length > 0) {
    return failResult("task-meta", `Missing required fields: ${missingFields.join(", ")}`);
  }

  const invalidDates = ["created_at", "updated_at", "completed_at", "blocked_at", "cancelled_at"]
    .filter((field) => !isBlank(metadata[field]) && !DATE_TIME_PATTERN.test(metadata[field]));
  if (invalidDates.length > 0) {
    return failResult("task-meta", `Invalid date format in: ${invalidDates.join(", ")}`);
  }

  for (const [field, allowedValues] of Object.entries(TASK_ENUMS)) {
    if (!isBlank(metadata[field]) && !allowedValues.includes(metadata[field])) {
      return failResult("task-meta", `Invalid ${field}: ${metadata[field]}`);
    }
  }

  const branchValidationError = validateTaskBranch(metadata);
  if (branchValidationError) {
    return failResult("task-meta", branchValidationError);
  }

  const expectedStep = config.expected_step;
  if (expectedStep && metadata.current_step !== expectedStep) {
    return failResult(
      "task-meta",
      `Expected current_step '${expectedStep}', got '${metadata.current_step || "(empty)"}'`
    );
  }

  const expectedStatus = config.expected_status;
  if (expectedStatus && metadata.status !== expectedStatus) {
    return failResult(
      "task-meta",
      `Expected status '${expectedStatus}', got '${metadata.status || "(empty)"}'`
    );
  }

  if (config.require_issue_number && !parseIssueNumber(metadata.issue_number)) {
    return failResult("task-meta", "Expected a valid issue_number in task metadata");
  }

  if (config.require_completed_at && isBlank(metadata.completed_at)) {
    return failResult("task-meta", "Expected completed_at to be present");
  }

  if (config.require_blocked_at && isBlank(metadata.blocked_at)) {
    return failResult("task-meta", "Expected blocked_at to be present");
  }

  if (config.require_cancelled_at && isBlank(metadata.cancelled_at)) {
    return failResult("task-meta", "Expected cancelled_at to be present");
  }

  if (config.match_task_dir !== false) {
    const expectedTaskId = path.basename(taskDir);
    if (metadata.id !== expectedTaskId) {
      return failResult("task-meta", `Task id '${metadata.id}' does not match directory '${expectedTaskId}'`);
    }
  }

  return passResult("task-meta", `Task metadata valid (${requiredFields.length} required fields checked)`);
}

function validateTaskBranch(metadata) {
  if (isBlank(metadata.branch)) {
    return null;
  }

  const projectName = loadProjectName();
  const expectedPrefix = projectName ? `${projectName}-${metadata.type}-` : "";

  if (expectedPrefix && !String(metadata.branch).startsWith(expectedPrefix)) {
    return `Invalid branch: expected prefix '${expectedPrefix}', got '${metadata.branch}'`;
  }

  const slug = expectedPrefix ? String(metadata.branch).slice(expectedPrefix.length) : String(metadata.branch);
  if (!BRANCH_SLUG_PATTERN.test(slug)) {
    return `Invalid branch: '${metadata.branch}' must use kebab-case suffixes`;
  }

  return null;
}

function loadProjectName() {
  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    return "";
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(config.project || "").trim();
  } catch {
    return "";
  }
}

function checkArtifact({ taskDir, config, artifactFile }) {
  const resolvedArtifact = resolveArtifactPath(taskDir, config.file_pattern, artifactFile);
  if (!resolvedArtifact.ok) {
    return failResult("artifact", resolvedArtifact.message);
  }

  const artifactPath = resolvedArtifact.path;
  const stat = safeStat(artifactPath);
  if (!stat) {
    return failResult("artifact", `Artifact not found: ${path.basename(artifactPath)}`);
  }

  if (stat.size === 0) {
    return failResult("artifact", `Artifact is empty: ${path.basename(artifactPath)}`);
  }

  const content = fs.readFileSync(artifactPath, "utf8");
  const requiredSections = config.required_sections || [];
  const missingSections = requiredSections.filter(
    (section) => !new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "m").test(content)
  );

  if (missingSections.length > 0) {
    return failResult(
      "artifact",
      `${path.basename(artifactPath)} is missing sections: ${missingSections.join(", ")}`
    );
  }

  const requiredPatterns = config.required_patterns || [];
  for (const pattern of requiredPatterns) {
    if (!new RegExp(pattern, "m").test(content)) {
      return failResult("artifact", `${path.basename(artifactPath)} is missing required pattern: ${pattern}`);
    }
  }

  const freshnessMinutes = Number(config.freshness_minutes ?? DEFAULT_FRESHNESS_MINUTES);
  const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
  if (Number.isFinite(freshnessMinutes) && ageMinutes > freshnessMinutes) {
    return failResult(
      "artifact",
      `${path.basename(artifactPath)} is stale (${ageMinutes.toFixed(1)}m old, limit ${freshnessMinutes}m)`
    );
  }

  return passResult(
    "artifact",
    `${path.basename(artifactPath)} passed (${requiredSections.length} sections, ${Math.max(0, freshnessMinutes)}m freshness window)`
  );
}

function checkActivityLog({ taskDir, config }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("activity-log", task.message);
  }

  const logSection = getSectionContent(task.content, ["活动日志", "Activity Log"]);
  if (!logSection) {
    return failResult("activity-log", "Activity Log section not found");
  }

  const entries = logSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  if (entries.length === 0) {
    return failResult("activity-log", "Activity Log has no entries");
  }

  let previousTimestamp = "";
  let latestAction = "";
  let latestTimestamp = "";

  for (const entry of entries) {
    const match = entry.match(ACTIVITY_LOG_PATTERN);
    if (!match) {
      return failResult("activity-log", `Invalid Activity Log entry format: ${entry}`);
    }

    const [, timestamp, action] = match;
    if (previousTimestamp && timestamp < previousTimestamp) {
      return failResult("activity-log", "Activity Log timestamps are not in ascending order");
    }

    previousTimestamp = timestamp;
    latestTimestamp = timestamp;
    latestAction = action;
  }

  if (config.expected_action_pattern && !new RegExp(config.expected_action_pattern).test(latestAction)) {
    return failResult(
      "activity-log",
      `Latest action '${latestAction}' does not match '${config.expected_action_pattern}'`
    );
  }

  const freshnessMinutes = Number(config.freshness_minutes ?? DEFAULT_FRESHNESS_MINUTES);
  if (Number.isFinite(freshnessMinutes)) {
    const ageMinutes = minutesSinceTimestamp(latestTimestamp);
    if (ageMinutes > freshnessMinutes) {
      return failResult(
        "activity-log",
        `Latest Activity Log entry is stale (${ageMinutes.toFixed(1)}m old, limit ${freshnessMinutes}m)`
      );
    }
  }

  return passResult("activity-log", `Latest entry '${latestAction}' at ${latestTimestamp}`);
}

function checkCompletionChecklist({ taskDir, config }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("completion-checklist", task.message);
  }

  const checklist = getSectionContent(task.content, ["完成检查清单", "Completion Checklist"]);
  if (!checklist) {
    return failResult("completion-checklist", "Completion Checklist section not found");
  }

  const items = checklist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- \[(?: |x|X)\] .+$/.test(line));

  if (items.length === 0) {
    return failResult("completion-checklist", "Completion Checklist has no checkbox items");
  }

  if (config.require_all_checked) {
    const unchecked = items
      .map((line) => line.match(/^- \[ \] (.+)$/))
      .filter(Boolean)
      .map((match) => match[1].trim());

    if (unchecked.length > 0) {
      return failResult(
        "completion-checklist",
        `Completion Checklist has unchecked items: ${unchecked.join(", ")}`
      );
    }
  }

  return passResult("completion-checklist", `Completion Checklist valid (${items.length} items checked)`);
}

// === File & Config Loaders ===

function loadVerifyConfig(skillName) {
  const verifyPath = path.join(repoRoot, ".agents", "skills", skillName, "config", "verify.json");
  if (!fs.existsSync(verifyPath)) {
    failUsage(`config/verify.json not found for skill '${skillName}'`);
  }

  return JSON.parse(fs.readFileSync(verifyPath, "utf8"));
}

function loadTask(taskDir) {
  const taskPath = path.join(taskDir, "task.md");
  if (!fs.existsSync(taskPath)) {
    return { ok: false, message: `Task file not found: ${taskPath}` };
  }

  const content = fs.readFileSync(taskPath, "utf8");
  const metadata = parseFrontmatter(content);
  if (!metadata) {
    return { ok: false, message: "task.md frontmatter not found or invalid" };
  }

  return { ok: true, content, metadata };
}

function resolveArtifactPath(taskDir, filePattern, artifactFile) {
  if (artifactFile) {
    return { ok: true, path: path.join(taskDir, artifactFile) };
  }

  if (!filePattern) {
    return { ok: false, message: "Artifact file is required for this check" };
  }

  const entries = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
  const matches = [];

  for (const pattern of filePattern.split("|").map((value) => value.trim()).filter(Boolean)) {
    const regex = new RegExp(`^${escapePattern(pattern)}$`);
    for (const entry of entries) {
      const match = entry.match(regex);
      if (!match) {
        continue;
      }

      matches.push({
        fileName: entry,
        round: match[1] ? Number(match[1]) : 0
      });
    }
  }

  if (matches.length === 0) {
    return { ok: false, message: `No artifact matched pattern '${filePattern}'` };
  }

  matches.sort((left, right) => right.round - left.round || left.fileName.localeCompare(right.fileName));
  return { ok: true, path: path.join(taskDir, matches[0].fileName) };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!parsed) {
      continue;
    }

    const [, key, rawValue] = parsed;
    metadata[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }

  return metadata;
}

function getSectionContent(content, names) {
  const lines = content.split(/\r?\n/);

  for (const name of names) {
    const heading = `## ${name}`;
    const startIndex = lines.findIndex((line) => line.trim() === heading);
    if (startIndex === -1) {
      continue;
    }

    const sectionLines = [];
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith("## ")) {
        break;
      }
      sectionLines.push(lines[index]);
    }

    return sectionLines.join("\n").trim();
  }

  return "";
}

function getCheckedRequirements(content) {
  const section = getSectionContent(content, ["需求", "Requirements"]);
  if (!section) {
    return [];
  }

  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^- \[x\] (.+)$/i))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

function parseIssueNumber(value) {
  if (isBlank(value) || value === "N/A") {
    return null;
  }

  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function parsePrNumber(value) {
  return parseIssueNumber(value);
}

function resolveOwnerRepo(taskDir) {
  const command = resolveCommand("git");
  const gitResult = spawnSync(command, ["remote", "get-url", "origin"], commandOptions(command, {
    cwd: taskDir,
    encoding: "utf8"
  }));

  if (gitResult.status !== 0) {
    const stderr = (gitResult.stderr || "").trim();
    const stdout = (gitResult.stdout || "").trim();
    return { ok: false, message: `Unable to resolve git remote: ${stderr || stdout}` };
  }

  const remote = gitResult.stdout.trim();
  const sshMatch = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!sshMatch) {
    return { ok: false, message: `Unable to parse owner/repo from remote '${remote}'` };
  }

  return { ok: true, value: sshMatch[1] };
}

function ghJson(args, cwd) {
  const result = ghCommand(args, cwd);
  if (!result.ok) {
    return result;
  }

  try {
    return { ok: true, value: JSON.parse(result.value || "null") };
  } catch (error) {
    return { ok: false, type: "network_error", message: `Invalid JSON from gh: ${error.message}` };
  }
}

function ghText(args, cwd) {
  const result = ghCommand(args, cwd);
  if (!result.ok) {
    return result;
  }

  return { ok: true, value: String(result.value || "").trim() };
}

function ghCommand(args, cwd) {
  const command = resolveCommand("gh");
  const result = spawnSync(command, args, commandOptions(command, {
    cwd,
    encoding: "utf8",
    env: process.env
  }));

  if (result.status !== 0) {
    const stderr = `${result.stderr || ""}${result.stdout || ""}`.trim();
    const classified = classifyGhFailure(stderr, args);
    return { ok: false, type: classified.type, message: classified.message };
  }

  return { ok: true, value: result.stdout };
}

function ghPaginatedJson(args, cwd) {
  return ghJson(args, cwd);
}

function gitText(args, cwd) {
  const command = resolveCommand("git");
  const result = spawnSync(command, args, commandOptions(command, {
    cwd,
    encoding: "utf8",
    env: process.env
  }));

  if (result.status !== 0) {
    const stderr = `${result.stderr || ""}${result.stdout || ""}`.trim();
    return {
      ok: false,
      type: "check_failed",
      message: stderr || `git ${args.join(" ")} failed`
    };
  }

  return { ok: true, value: String(result.stdout || "").trim() };
}

function withRetry(operation) {
  const delays = getRetryDelays();
  let lastFailure = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const result = operation();
    if (result.ok) {
      return result;
    }

    lastFailure = result;
    if (result.type === "check_failed") {
      return result;
    }

    if (attempt < delays.length) {
      sleep(delays[attempt]);
    }
  }

  return lastFailure || { ok: false, type: "network_error", message: "Unknown GitHub sync failure" };
}

function classifyGhFailure(stderr, args) {
  const message = stderr || `gh ${args.join(" ")} failed`;

  if (/not found|could not resolve to an issue|http 404/i.test(message)) {
    return { type: "check_failed", message };
  }

  return { type: "network_error", message };
}

function getRetryDelays() {
  const override = process.env.VALIDATE_ARTIFACT_RETRY_DELAYS_MS;
  if (!override) {
    return DEFAULT_RETRY_DELAYS_MS;
  }

  const parsed = override
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

function sleep(delayMs) {
  if (delayMs <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function resolveCommand(cmd) {
  if (process.platform !== "win32" || path.extname(cmd)) {
    return cmd;
  }

  const pathValue = process.env.Path || process.env.PATH || "";
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const lowerCandidate = path.join(dir, `${cmd}${extension.toLowerCase()}`);
      if (fs.existsSync(lowerCandidate)) {
        return lowerCandidate;
      }
      const upperCandidate = path.join(dir, `${cmd}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) {
        return upperCandidate;
      }
    }
  }

  return cmd;
}

function commandOptions(cmd, options) {
  if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(cmd)) {
    return { ...options, shell: true };
  }
  return options;
}

// === Utilities ===

function normalizeContent(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function minutesSinceTimestamp(timestamp) {
  const normalized = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return (Date.now() - parsed) / 60000;
}

function interpolate(template, taskDir, artifactFile) {
  const artifactStem = artifactFile ? path.basename(artifactFile, path.extname(artifactFile)) : "";
  return template
    .replace(/\{task-id\}/g, path.basename(taskDir))
    .replace(/\{artifact-stem\}/g, artifactStem);
}

function summarizeGate(checks) {
  if (checks.some((check) => check.status === "blocked")) {
    return "blocked";
  }

  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  return "pass";
}

function summarizeChecks(checks) {
  const counts = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    blocked: checks.filter((check) => check.status === "blocked").length
  };

  if (counts.blocked > 0) {
    return `${counts.pass} passed, ${counts.fail} failed, ${counts.blocked} blocked`;
  }

  return `${counts.pass} passed, ${counts.fail} failed`;
}

function buildAction(gate, checks) {
  if (gate === "pass") {
    return "All declared checks passed";
  }

  const firstFailure = checks.find((check) => check.status !== "pass");
  if (!firstFailure) {
    return "Review validation output";
  }

  if (gate === "blocked") {
    return `Resolve blocked ${firstFailure.type} check and re-run gate`;
  }

  return `Fix ${firstFailure.type} issues and re-run gate`;
}

function buildCheckAction(result) {
  if (result.status === "pass") {
    return "Requested check passed";
  }

  if (result.status === "blocked") {
    return `Resolve blocked ${result.type} check and re-run check`;
  }

  return `Fix ${result.type} issues and re-run check`;
}

function buildSingleCheckSummary(status) {
  if (status === "pass") {
    return "1 passed, 0 failed";
  }

  if (status === "blocked") {
    return "0 passed, 0 failed, 1 blocked";
  }

  return "0 passed, 1 failed";
}

function passResult(type, message) {
  return { type, status: "pass", message };
}

function failResult(type, message, failType = "check_failed") {
  return { type, status: "fail", fail_type: failType, message };
}

function blockedResult(type, message, failType = "network_error") {
  return { type, status: "blocked", fail_type: failType, message };
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function escapePattern(pattern) {
  return escapeRegExp(pattern)
    .replace(/\\\{N\\\}/g, "(\\d+)");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function extractOption(args, name) {
  const rest = [];
  let value;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      value = args[index + 1];
      index += 1;
      continue;
    }

    const inlinePrefix = `${name}=`;
    if (arg.startsWith(inlinePrefix)) {
      value = arg.slice(inlinePrefix.length);
      continue;
    }

    rest.push(arg);
  }

  return { value, rest };
}

function normalizeFormat(value) {
  return value === "text" ? "text" : "json";
}

function formatStatusLabel(status) {
  if (status === "fail") {
    return "FAIL";
  }

  if (status === "blocked") {
    return "BLOCKED";
  }

  return "pass";
}

function writeOutput(value, format) {
  if (format === "text") {
    writeText(value);
    return;
  }

  writeJson(value);
}

function writeText(value) {
  const lines = [];

  if (Array.isArray(value.checks)) {
    lines.push(`Verification: ${value.gate} | Skill: ${value.skill}`);
    lines.push("");
    for (const check of value.checks) {
      lines.push(`  [${formatStatusLabel(check.status)}] ${check.type} - ${check.message}`);
    }
    lines.push("");
    lines.push(`Result: ${value.summary} - ${value.action}`);
  } else {
    lines.push(`Check: ${value.status} | Skill: ${value.skill} | Type: ${value.type}`);
    lines.push("");
    lines.push(`  [${formatStatusLabel(value.status)}] ${value.type} - ${value.message}`);
    lines.push("");
    lines.push(`Result: ${buildSingleCheckSummary(value.status)} - ${buildCheckAction(value)}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsageAndExit() {
  failUsage(
    "Usage:\n" +
      "  node .agents/scripts/validate-artifact.js gate <skill-name> <task-dir> [artifact-file] [--format json|text]\n" +
      "  node .agents/scripts/validate-artifact.js check <type> <task-dir> [artifact-file] --skill <skill-name> [--format json|text]"
  );
}

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main(process.argv.slice(2));
