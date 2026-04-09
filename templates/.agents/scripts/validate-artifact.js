#!/usr/bin/env node

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
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ACTIVITY_LOG_PATTERN = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.+)$/;
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

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
    case "github-sync":
      return checkGithubSync(context);
    default:
      return failResult(type, `Unsupported check type '${type}'.`);
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

function checkGithubSync({ taskDir, config, artifactFile }) {
  const context = buildSyncContext({ taskDir, config, artifactFile });
  if (context.earlyReturn) {
    return context.earlyReturn;
  }

  const remoteData = fetchRemoteData(context);
  if (remoteData.earlyReturn) {
    return remoteData.earlyReturn;
  }

  const subChecks = [
    checkStatusLabel,
    checkCommentMarker,
    checkPrCommentMarker,
    checkCommentContent,
    checkTaskCommentContent,
    checkInLabelsMatchPr,
    checkSyncedRequirements,
    checkIssueType,
    checkMilestone
  ];

  for (const subCheck of subChecks) {
    const result = subCheck(context, remoteData);
    if (result) {
      return result;
    }
  }

  return passResult("github-sync", `GitHub sync checks passed for Issue #${context.issueNumber}`);
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

function buildSyncContext({ taskDir, config, artifactFile }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return { earlyReturn: failResult("github-sync", task.message) };
  }

  const issueNumber = parseIssueNumber(task.metadata.issue_number);
  const prNumber = parsePrNumber(task.metadata.pr_number);
  if (config.when === "issue_number_exists" && !issueNumber) {
    return { earlyReturn: passResult("github-sync", "Skipped: task has no issue_number") };
  }
  if (config.when === "pr_number_exists" && !prNumber) {
    return { earlyReturn: passResult("github-sync", "Skipped: task has no pr_number") };
  }

  if (!issueNumber) {
    return { earlyReturn: passResult("github-sync", "Skipped: github-sync not required for this task") };
  }

  const ownerRepo = resolveOwnerRepo(taskDir);
  if (!ownerRepo.ok) {
    return { earlyReturn: blockedResult("github-sync", ownerRepo.message, "network_error") };
  }

  const marker = config.expected_comment_marker
    ? interpolate(config.expected_comment_marker, taskDir, artifactFile)
    : null;
  const prMarker = config.expected_pr_comment_marker
    ? interpolate(config.expected_pr_comment_marker, taskDir, artifactFile)
    : null;
  const artifactPath = artifactFile ? path.join(taskDir, artifactFile) : null;

  return {
    task,
    taskDir,
    config,
    artifactFile,
    artifactPath,
    issueNumber,
    prNumber,
    ownerRepo: ownerRepo.value,
    marker,
    prMarker
  };
}

function fetchRemoteData(context) {
  const issueResult = withRetry(() => ghJson([
    "issue",
    "view",
    String(context.issueNumber),
    "--json",
    "state,labels,body,milestone"
  ], context.taskDir));
  if (!issueResult.ok) {
    return {
      earlyReturn: issueResult.type === "check_failed"
        ? failResult("github-sync", issueResult.message, issueResult.type)
        : blockedResult("github-sync", issueResult.message, issueResult.type)
    };
  }

  const issue = issueResult.value;
  if (context.config.issue_must_exist !== false && !issue) {
    return {
      earlyReturn: failResult("github-sync", `Issue #${context.issueNumber} not found`, "check_failed")
    };
  }

  let comments = null;
  if (shouldFetchComments(context.config)) {
    const commentsResult = withRetry(() => ghPaginatedJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${context.ownerRepo}/issues/${context.issueNumber}/comments?per_page=100`
    ], context.taskDir));

    if (!commentsResult.ok) {
      return {
        earlyReturn: commentsResult.type === "check_failed"
          ? failResult("github-sync", commentsResult.message, commentsResult.type)
          : blockedResult("github-sync", commentsResult.message, commentsResult.type)
      };
    }

    comments = flattenComments(commentsResult.value);
  }

  let prComments = null;
  if (context.config.expected_pr_comment_marker) {
    if (!context.prNumber) {
      return {
        earlyReturn: failResult("github-sync", "Expected a valid pr_number for PR comment verification", "check_failed")
      };
    }

    const prCommentsResult = withRetry(() => ghPaginatedJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${context.ownerRepo}/issues/${context.prNumber}/comments?per_page=100`
    ], context.taskDir));

    if (!prCommentsResult.ok) {
      return {
        earlyReturn: prCommentsResult.type === "check_failed"
          ? failResult("github-sync", prCommentsResult.message, prCommentsResult.type)
          : blockedResult("github-sync", prCommentsResult.message, prCommentsResult.type)
      };
    }

    prComments = flattenComments(prCommentsResult.value);
  }

  let issueType;
  if (context.config.verify_issue_type) {
    const issueTypeResult = withRetry(() => ghText([
      "api",
      `repos/${context.ownerRepo}/issues/${context.issueNumber}`,
      "--jq",
      ".type.name // empty"
    ], context.taskDir));

    if (issueTypeResult.ok) {
      issueType = issueTypeResult.value || null;
    }
  }

  let prLabels = null;
  let prMilestone;
  if ((context.config.verify_in_labels_match_pr || context.config.verify_milestone) && context.prNumber) {
    const prFields = [];
    if (context.config.verify_in_labels_match_pr) {
      prFields.push("labels");
    }
    if (context.config.verify_milestone) {
      prFields.push("milestone");
    }

    const prResult = withRetry(() => ghJson([
      "pr",
      "view",
      String(context.prNumber),
      "--json",
      prFields.join(",")
    ], context.taskDir));

    if (!prResult.ok) {
      return {
        earlyReturn: prResult.type === "check_failed"
          ? failResult("github-sync", prResult.message, prResult.type)
          : blockedResult("github-sync", prResult.message, prResult.type)
      };
    }

    prLabels = context.config.verify_in_labels_match_pr
      ? extractLabelNames(prResult.value?.labels)
      : null;
    prMilestone = context.config.verify_milestone
      ? prResult.value?.milestone ?? null
      : undefined;
  }

  return {
    issue,
    comments,
    prComments,
    prLabels,
    issueType,
    prMilestone
  };
}

function shouldFetchComments(config) {
  return Boolean(
    config.expected_comment_marker
    || config.expected_pr_comment_marker
    || config.verify_comment_content
    || config.verify_task_comment_content
  );
}

function flattenComments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((page) => Array.isArray(page) ? page : []);
}

function checkStatusLabel(context, remoteData) {
  if (!context.config.expected_status_label || remoteData.issue.state !== "OPEN") {
    return null;
  }

  const labels = extractLabelNames(remoteData.issue.labels);
  if (labels.includes(context.config.expected_status_label)) {
    return null;
  }

  return failResult(
    "github-sync",
    `Expected label '${context.config.expected_status_label}' not found on Issue #${context.issueNumber}`,
    "check_failed"
  );
}

function checkCommentMarker(context, remoteData) {
  if (!context.marker) {
    return null;
  }

  const comment = findCommentByMarker(remoteData.comments, context.marker);
  if (comment) {
    return null;
  }

  return failResult(
    "github-sync",
    `Expected comment marker '${context.marker}' not found on Issue #${context.issueNumber}`,
    "check_failed"
  );
}

function checkPrCommentMarker(context, remoteData) {
  if (!context.prMarker) {
    return null;
  }

  const comment = findCommentByMarker(remoteData.prComments, context.prMarker);
  if (comment) {
    return null;
  }

  return failResult(
    "github-sync",
    `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
    "check_failed"
  );
}

function checkCommentContent(context, remoteData) {
  if (!context.config.verify_comment_content) {
    return null;
  }

  if (!context.marker) {
    return failResult("github-sync", "verify_comment_content requires expected_comment_marker", "check_failed");
  }

  if (!context.artifactPath || !safeStat(context.artifactPath)) {
    return failResult(
      "github-sync",
      `Artifact not found for comment verification: ${context.artifactFile || "(missing artifactFile)"}`,
      "check_failed"
    );
  }

  const comment = findCommentByMarker(remoteData.comments, context.marker);
  const localContent = normalizeContent(fs.readFileSync(context.artifactPath, "utf8"));
  const commentContent = normalizeContent(extractCommentBody(comment?.body || ""));

  if (localContent === commentContent) {
    return null;
  }

  return failResult(
    "github-sync",
    buildCommentContentMismatchMessage(
      path.basename(context.artifactPath, path.extname(context.artifactPath)),
      context.issueNumber,
      localContent,
      commentContent
    ),
    "check_failed"
  );
}

function checkTaskCommentContent(context, remoteData) {
  if (!context.config.verify_task_comment_content) {
    return null;
  }

  const taskMarker = `<!-- sync-issue:${context.task.metadata.id}:task -->`;
  const comment = findCommentByMarker(remoteData.comments, taskMarker);
  if (!comment) {
    return failResult(
      "github-sync",
      `Expected comment marker '${taskMarker}' not found on Issue #${context.issueNumber}`,
      "check_failed"
    );
  }

  const expectedBody = normalizeContent(buildExpectedTaskBody(context.task.content));
  const commentBody = normalizeContent(extractCommentBody(comment.body || ""));

  if (expectedBody === commentBody) {
    return null;
  }

  return failResult(
    "github-sync",
    buildCommentContentMismatchMessage("task", context.issueNumber, expectedBody, commentBody),
    "check_failed"
  );
}

function checkInLabelsMatchPr(context, remoteData) {
  if (!context.config.verify_in_labels_match_pr || !context.prNumber || !remoteData.prLabels) {
    return null;
  }

  const issueInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label) => label.startsWith("in:"))
    .sort();
  const prInLabels = remoteData.prLabels
    .filter((label) => label.startsWith("in:"))
    .sort();

  if (arraysEqual(issueInLabels, prInLabels)) {
    return null;
  }

  return failResult(
    "github-sync",
    `in: labels mismatch — PR #${context.prNumber} has [${formatLabelList(prInLabels)}], Issue #${context.issueNumber} has [${formatLabelList(issueInLabels)}]`,
    "check_failed"
  );
}

function checkSyncedRequirements(context, remoteData) {
  if (!context.config.sync_checked_requirements) {
    return null;
  }

  const checkedRequirements = getCheckedRequirements(context.task.content);
  if (checkedRequirements.length === 0) {
    return null;
  }

  const issueBody = remoteData.issue.body || "";
  const missingRequirements = checkedRequirements.filter(
    (item) => !new RegExp(`^- \\[x\\] ${escapeRegExp(item)}$`, "m").test(issueBody)
  );
  if (missingRequirements.length === 0) {
    return null;
  }

  return failResult(
    "github-sync",
    `Issue body is missing checked requirements: ${missingRequirements.join(", ")}`,
    "check_failed"
  );
}

function checkIssueType(context, remoteData) {
  if (!context.config.verify_issue_type) {
    return null;
  }

  if (remoteData.issueType === undefined) {
    return null;
  }

  if (!remoteData.issueType) {
    return failResult(
      "github-sync",
      `Issue #${context.issueNumber} has no Issue Type set`,
      "check_failed"
    );
  }

  const expectedType = mapTaskTypeToIssueType(context.task.metadata.type);
  if (expectedType && remoteData.issueType !== expectedType) {
    return failResult(
      "github-sync",
      `Issue #${context.issueNumber} has type '${remoteData.issueType}', expected '${expectedType}' (from task type '${context.task.metadata.type}')`,
      "check_failed"
    );
  }

  return null;
}

function checkMilestone(context, remoteData) {
  if (!context.config.verify_milestone) {
    return null;
  }

  if (!remoteData.issue?.milestone?.title) {
    return failResult(
      "github-sync",
      `Issue #${context.issueNumber} has no milestone set`,
      "check_failed"
    );
  }

  if (context.prNumber && remoteData.prMilestone !== undefined && !remoteData.prMilestone?.title) {
    return failResult(
      "github-sync",
      `PR #${context.prNumber} has no milestone set`,
      "check_failed"
    );
  }

  return null;
}

function findCommentByMarker(comments, marker) {
  return (comments || []).find((comment) => typeof comment.body === "string" && comment.body.includes(marker)) || null;
}

function extractCommentBody(commentBody) {
  const lines = String(commentBody || "").split(/\r?\n/);

  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || /^<!--.*-->$/.test(lines[start].trim()))) {
    start += 1;
  }

  if (start < lines.length && lines[start].startsWith("## ")) {
    start += 1;
  }

  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }

  if (start < lines.length && /^> \*\*.+\*\* · .+$/.test(lines[start].trim())) {
    start += 1;
  }

  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }

  let end = lines.length;
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "") {
      continue;
    }

    if (/^\*.*\*$/.test(trimmed)) {
      end = index;
      if (end > start && lines[end - 1].trim() === "---") {
        end -= 1;
      }
    }
    break;
  }

  return lines.slice(start, end).join("\n");
}

function buildExpectedTaskBody(taskContent) {
  const frontmatterMatch = taskContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return taskContent.trim();
  }

  const body = taskContent.slice(frontmatterMatch[0].length).trim();
  return [
    buildTaskFrontmatterSummary(),
    "",
    "```yaml",
    frontmatterMatch[0].trim(),
    "```",
    "",
    "</details>",
    "",
    body
  ].join("\n").trim();
}

function buildTaskFrontmatterSummary() {
  const language = loadProjectLanguage();
  if (language === "en" || language === "en-US") {
    return "<details><summary>Metadata (frontmatter)</summary>";
  }

  return "<details><summary>元数据 (frontmatter)</summary>";
}

function loadProjectLanguage() {
  const override = process.env.VALIDATE_ARTIFACT_LANGUAGE;
  if (!isBlank(override)) {
    return String(override).trim();
  }

  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    return "";
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(config.language || "").trim();
  } catch {
    return "";
  }
}

function normalizeContent(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildCommentContentMismatchMessage(fileStem, issueNumber, localContent, commentContent) {
  const diffIndex = firstDifferenceIndex(localContent, commentContent);
  const position = indexToLineColumn(localContent, diffIndex);

  return `Comment content mismatch for '${fileStem}' on Issue #${issueNumber}: local file has ${localContent.length} chars, comment body has ${commentContent.length} chars (first difference near char ${diffIndex + 1}, line ${position.line}, column ${position.column})`;
}

function firstDifferenceIndex(left, right) {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }

  return limit;
}

function indexToLineColumn(text, index) {
  const prefix = text.slice(0, Math.min(index, text.length));
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1) || "").length + 1
  };
}

function extractLabelNames(labels) {
  return (labels || [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => typeof label === "string" && label.length > 0);
}

function mapTaskTypeToIssueType(taskType) {
  const mapping = {
    bug: "Bug",
    bugfix: "Bug",
    enhancement: "Feature",
    feature: "Feature",
    task: "Task",
    documentation: "Task",
    "dependency-upgrade": "Task",
    chore: "Task",
    docs: "Task",
    refactor: "Task",
    refactoring: "Task"
  };

  return mapping[taskType] || "Task";
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function formatLabelList(labels) {
  return labels.length > 0 ? labels.join(", ") : "none";
}

// === GitHub API ===

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
  const gitResult = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: taskDir,
    encoding: "utf8"
  });

  if (gitResult.status !== 0) {
    return { ok: false, message: `Unable to resolve git remote: ${gitResult.stderr.trim() || gitResult.stdout.trim()}` };
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
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    env: process.env
  });

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

// === Utilities ===

function minutesSinceTimestamp(timestamp) {
  const normalized = timestamp.replace(" ", "T");
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
