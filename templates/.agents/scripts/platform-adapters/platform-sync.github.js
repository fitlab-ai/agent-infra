import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const CHECK_TYPE = "platform-sync";
const DEFAULT_RETRY_DELAYS_MS = [3000, 10000];

let activeShared = null;
let repoRoot = "";

function getShared() {
  if (!activeShared) {
    throw new Error("platform-sync adapter shared utilities are unavailable");
  }

  return activeShared;
}

function loadTask(...args) {
  return getShared().loadTask(...args);
}

function getCheckedRequirements(...args) {
  return getShared().getCheckedRequirements(...args);
}

function normalizeContent(...args) {
  return getShared().normalizeContent(...args);
}

function isBlank(...args) {
  return getShared().isBlank(...args);
}

function escapeRegExp(...args) {
  return getShared().escapeRegExp(...args);
}

function passResult(...args) {
  return getShared().passResult(...args);
}

function failResult(...args) {
  return getShared().failResult(...args);
}

function blockedResult(...args) {
  return getShared().blockedResult(...args);
}

function safeStat(...args) {
  return getShared().safeStat(...args);
}

function parseIssueNumber(...args) {
  return getShared().parseIssueNumber(...args);
}

function parsePrNumber(...args) {
  return getShared().parsePrNumber(...args);
}

export function check({ taskDir, config, artifactFile }, shared) {
  activeShared = shared;
  repoRoot = shared.repoRoot;
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
    checkPrCommentLastCommit,
    checkCommentContent,
    checkTaskCommentContent,
    checkInLabelsComputed,
    checkPrTypeLabel,
    checkInLabelsMatchPr,
    checkPrAssignee,
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

  return passResult(CHECK_TYPE, `GitHub sync checks passed for Issue #${context.issueNumber}`);
}

function buildSyncContext({ taskDir, config, artifactFile }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return { earlyReturn: failResult(CHECK_TYPE, task.message) };
  }

  const issueNumber = parseIssueNumber(task.metadata.issue_number);
  const prNumber = parsePrNumber(task.metadata.pr_number);
  if (config.when === "issue_number_exists" && !issueNumber) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: task has no issue_number") };
  }
  if (config.when === "pr_number_exists" && !prNumber) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: task has no pr_number") };
  }

  if (!issueNumber) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: platform-sync not required for this task") };
  }

  const upstreamRepo = resolveUpstreamRepo(taskDir);
  if (!upstreamRepo.ok) {
    return { earlyReturn: blockedResult(CHECK_TYPE, upstreamRepo.message, "network_error") };
  }
  const permissions = detectPermissions(upstreamRepo.value, taskDir);

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
    upstreamRepo: upstreamRepo.value,
    hasTriage: permissions.hasTriage,
    hasPush: permissions.hasPush,
    marker,
    prMarker
  };
}

function fetchRemoteData(context) {
  let issueResult = withRetry(() => ghJson([
    "issue",
    "view",
    String(context.issueNumber),
    "-R",
    context.upstreamRepo,
    "--json",
    "state,labels,body,milestone"
  ], context.taskDir));
  if (!issueResult.ok && issueResult.type !== "check_failed") {
    const fallbackIssueResult = withRetry(() => ghJson([
      "api",
      `repos/${context.upstreamRepo}/issues/${context.issueNumber}`
    ], context.taskDir));
    if (fallbackIssueResult.ok) {
      issueResult = {
        ok: true,
        value: normalizeIssuePayload(fallbackIssueResult.value)
      };
    } else {
      issueResult = fallbackIssueResult;
    }
  }
  if (!issueResult.ok) {
    return {
      earlyReturn: issueResult.type === "check_failed"
        ? failResult(CHECK_TYPE, issueResult.message, issueResult.type)
        : blockedResult(CHECK_TYPE, issueResult.message, issueResult.type)
    };
  }

  const issue = issueResult.value;
  if (context.config.issue_must_exist !== false && !issue) {
    return {
      earlyReturn: failResult(CHECK_TYPE, `Issue #${context.issueNumber} not found`, "check_failed")
    };
  }

  let comments = null;
  if (shouldFetchComments(context.config)) {
    const commentsResult = withRetry(() => ghPaginatedJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${context.upstreamRepo}/issues/${context.issueNumber}/comments?per_page=100`
    ], context.taskDir));

    if (!commentsResult.ok) {
      return {
        earlyReturn: commentsResult.type === "check_failed"
          ? failResult(CHECK_TYPE, commentsResult.message, commentsResult.type)
          : blockedResult(CHECK_TYPE, commentsResult.message, commentsResult.type)
      };
    }

    comments = flattenComments(commentsResult.value);
  }

  let prComments = null;
  if (context.config.expected_pr_comment_marker) {
    if (!context.prNumber) {
      return {
        earlyReturn: failResult(CHECK_TYPE, "Expected a valid pr_number for PR comment verification", "check_failed")
      };
    }

    const prCommentsResult = withRetry(() => ghPaginatedJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${context.upstreamRepo}/issues/${context.prNumber}/comments?per_page=100`
    ], context.taskDir));

    if (!prCommentsResult.ok) {
      return {
        earlyReturn: prCommentsResult.type === "check_failed"
          ? failResult(CHECK_TYPE, prCommentsResult.message, prCommentsResult.type)
          : blockedResult(CHECK_TYPE, prCommentsResult.message, prCommentsResult.type)
      };
    }

    prComments = flattenComments(prCommentsResult.value);
  }

  let issueType;
  if (context.config.verify_issue_type && context.hasPush) {
    const issueTypeResult = withRetry(() => ghText([
      "api",
      `repos/${context.upstreamRepo}/issues/${context.issueNumber}`,
      "--jq",
      ".type.name // empty"
    ], context.taskDir));

    if (issueTypeResult.ok) {
      issueType = issueTypeResult.value || null;
    }
  }

  let prLabels = null;
  let prMilestone;
  let prAssignees;
  if (((context.config.verify_in_labels_match_pr && context.hasTriage)
    || (context.config.verify_pr_type_label && context.hasTriage)
    || (context.config.verify_milestone && context.hasTriage)
    || (context.config.verify_pr_assignee && context.hasPush)) && context.prNumber) {
    const prFields = [];
    if (context.config.verify_in_labels_match_pr || context.config.verify_pr_type_label) {
      prFields.push("labels");
    }
    if (context.config.verify_milestone) {
      prFields.push("milestone");
    }
    if (context.config.verify_pr_assignee) {
      prFields.push("assignees");
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
          ? failResult(CHECK_TYPE, prResult.message, prResult.type)
          : blockedResult(CHECK_TYPE, prResult.message, prResult.type)
      };
    }

    prLabels = (context.config.verify_in_labels_match_pr || context.config.verify_pr_type_label)
      ? extractLabelNames(prResult.value?.labels)
      : null;
    prMilestone = context.config.verify_milestone
      ? prResult.value?.milestone ?? null
      : undefined;
    prAssignees = context.config.verify_pr_assignee
      ? (prResult.value?.assignees || []).map((a) => a.login).filter(Boolean)
      : undefined;
  }

  return {
    issue,
    comments,
    prComments,
    prLabels,
    issueType,
    prMilestone,
    prAssignees
  };
}

function mapTaskTypeToLabel(taskType) {
  const mapping = {
    bug: "type: bug",
    bugfix: "type: bug",
    feature: "type: feature",
    enhancement: "type: enhancement",
    refactor: "type: enhancement",
    refactoring: "type: enhancement",
    documentation: "type: documentation",
    "dependency-upgrade": "type: dependency-upgrade",
    task: "type: task"
  };

  return mapping[taskType] || null;
}

function shouldFetchComments(config) {
  return Boolean(
    config.expected_comment_marker
    || config.expected_pr_comment_marker
    || config.verify_pr_comment_last_commit_matches_head
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
  if (!context.config.expected_status_label || !context.hasTriage) {
    return null;
  }

  if (String(remoteData.issue.state || "").toUpperCase() !== "OPEN") {
    return null;
  }

  const labels = extractLabelNames(remoteData.issue.labels);
  if (labels.includes(context.config.expected_status_label)) {
    return null;
  }

  return failResult(CHECK_TYPE,
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

  return failResult(CHECK_TYPE,
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

  return failResult(CHECK_TYPE,
    `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
    "check_failed"
  );
}

function checkPrCommentLastCommit(context, remoteData) {
  if (!context.config.verify_pr_comment_last_commit_matches_head) {
    return null;
  }

  if (!context.prMarker) {
    return failResult(CHECK_TYPE,
      "verify_pr_comment_last_commit_matches_head requires expected_pr_comment_marker",
      "check_failed"
    );
  }

  const comment = findCommentByMarker(remoteData.prComments, context.prMarker);
  if (!comment) {
    return failResult(CHECK_TYPE,
      `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
      "check_failed"
    );
  }

  const match = String(comment.body || "").match(/<!--\s*last-commit:\s*([0-9a-f]{7,40})\s*-->/i);
  if (!match) {
    return failResult(CHECK_TYPE,
      `PR #${context.prNumber} summary comment is missing '<!-- last-commit: <sha> -->' metadata`,
      "check_failed"
    );
  }

  const headResult = withRetry(() => gitText(["rev-parse", "HEAD"], context.taskDir));
  if (!headResult.ok) {
    return headResult.type === "check_failed"
      ? failResult(CHECK_TYPE, headResult.message, headResult.type)
      : blockedResult(CHECK_TYPE, headResult.message, headResult.type);
  }

  const expectedHead = String(headResult.value || "").trim();
  const actualHead = match[1].trim();
  if (expectedHead === actualHead) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `PR #${context.prNumber} summary comment last-commit metadata mismatch: expected ${expectedHead}, got ${actualHead}`,
    "check_failed"
  );
}

function checkCommentContent(context, remoteData) {
  if (!context.config.verify_comment_content) {
    return null;
  }

  if (!context.marker) {
    return failResult(CHECK_TYPE, "verify_comment_content requires expected_comment_marker", "check_failed");
  }

  if (!context.artifactPath || !safeStat(context.artifactPath)) {
    return failResult(CHECK_TYPE,
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

  return failResult(CHECK_TYPE,
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
    return failResult(CHECK_TYPE,
      `Expected comment marker '${taskMarker}' not found on Issue #${context.issueNumber}`,
      "check_failed"
    );
  }

  const expectedBody = normalizeContent(buildExpectedTaskBody(context.task.content));
  const commentBody = normalizeContent(extractCommentBody(comment.body || ""));

  if (expectedBody === commentBody) {
    return null;
  }

  return failResult(CHECK_TYPE,
    buildCommentContentMismatchMessage("task", context.issueNumber, expectedBody, commentBody),
    "check_failed"
  );
}

function checkPrTypeLabel(context, remoteData) {
  if (!context.config.verify_pr_type_label || !context.hasTriage || !context.prNumber || !remoteData.prLabels) {
    return null;
  }

  const expectedLabel = mapTaskTypeToLabel(context.task.metadata.type);
  if (!expectedLabel) {
    return null;
  }

  if (remoteData.prLabels.includes(expectedLabel)) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `Expected type label '${expectedLabel}' not found on PR #${context.prNumber}`,
    "check_failed"
  );
}

function checkInLabelsMatchPr(context, remoteData) {
  if (!context.config.verify_in_labels_match_pr || !context.hasTriage || !context.prNumber || !remoteData.prLabels) {
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

  return failResult(CHECK_TYPE,
    `in: labels mismatch — PR #${context.prNumber} has [${formatLabelList(prInLabels)}], Issue #${context.issueNumber} has [${formatLabelList(issueInLabels)}]`,
    "check_failed"
  );
}

function checkInLabelsComputed(context, remoteData) {
  if (!context.config.verify_in_labels_computed || !context.hasTriage) {
    return null;
  }

  const expectedInLabels = computeExpectedInLabels(context.taskDir);
  if (!expectedInLabels.ok) {
    return expectedInLabels.type === "check_failed"
      ? failResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type)
      : blockedResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type);
  }

  if (expectedInLabels.mode === "skipped") {
    return null;
  }

  const actualInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label) => label.startsWith("in:"))
    .sort();

  if (arraysEqual(expectedInLabels.labels, actualInLabels)) {
    return null;
  }

  return failResult(
    CHECK_TYPE,
    `Issue #${context.issueNumber} in: labels do not match committed changes: expected [${formatLabelList(expectedInLabels.labels)}], got [${formatLabelList(actualInLabels)}]`,
    "check_failed"
  );
}

function checkSyncedRequirements(context, remoteData) {
  if (!context.config.sync_checked_requirements || !context.hasTriage) {
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

  return failResult(CHECK_TYPE,
    `Issue body is missing checked requirements: ${missingRequirements.join(", ")}`,
    "check_failed"
  );
}

function checkIssueType(context, remoteData) {
  if (!context.config.verify_issue_type || !context.hasPush) {
    return null;
  }

  if (remoteData.issueType === undefined) {
    return null;
  }

  if (!remoteData.issueType) {
    return failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has no Issue Type set`,
      "check_failed"
    );
  }

  const expectedType = mapTaskTypeToIssueType(context.task.metadata.type);
  if (expectedType && remoteData.issueType !== expectedType) {
    return failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has type '${remoteData.issueType}', expected '${expectedType}' (from task type '${context.task.metadata.type}')`,
      "check_failed"
    );
  }

  return null;
}

function checkPrAssignee(context, remoteData) {
  if (!context.config.verify_pr_assignee || !context.hasPush || !context.prNumber) {
    return null;
  }

  if (!remoteData.prAssignees || remoteData.prAssignees.length === 0) {
    return failResult(CHECK_TYPE,
      `PR #${context.prNumber} has no assignee`,
      "check_failed"
    );
  }

  return null;
}

function checkMilestone(context, remoteData) {
  if (!context.config.verify_milestone || !context.hasTriage) {
    return null;
  }

  if (!remoteData.issue?.milestone?.title) {
    return failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has no milestone set`,
      "check_failed"
    );
  }

  if (context.prNumber && remoteData.prMilestone !== undefined && !remoteData.prMilestone?.title) {
    return failResult(CHECK_TYPE,
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

function computeExpectedInLabels(taskDir) {
  const changedFilesResult = gitText(["diff", "main...HEAD", "--name-only"], taskDir);
  if (!changedFilesResult.ok) {
    return changedFilesResult;
  }

  const changedFiles = String(changedFilesResult.value || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  const mapping = loadInLabelMapping();
  if (!mapping.ok) {
    return mapping;
  }

  if (Object.keys(mapping.value).length > 0) {
    const labels = new Set();

    for (const file of changedFiles) {
      for (const [label, prefixes] of Object.entries(mapping.value)) {
        if (prefixes.some((prefix) => file.startsWith(prefix))) {
          labels.add(`in: ${label}`);
        }
      }
    }

    return { ok: true, labels: Array.from(labels).sort(), mode: "mapped" };
  }

  const repoLabelsResult = ghJson([
    "label",
    "list",
    "--limit",
    "200",
    "--json",
    "name"
  ], taskDir);
  if (!repoLabelsResult.ok) {
    return repoLabelsResult;
  }

  const repoInLabels = new Set(
    extractLabelNames(repoLabelsResult.value)
      .filter((label) => label.startsWith("in:"))
  );

  if (repoInLabels.size === 0) {
    return { ok: true, labels: [], mode: "fallback" };
  }

  const labels = new Set();
  for (const file of changedFiles) {
    const topLevel = file.split("/")[0];
    if (!topLevel) {
      continue;
    }

    const candidate = `in: ${topLevel}`;
    if (repoInLabels.has(candidate)) {
      labels.add(candidate);
    }
  }

  return { ok: true, labels: Array.from(labels).sort(), mode: "fallback" };
}

function loadInLabelMapping() {
  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    return { ok: true, value: {} };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const mapping = config?.labels?.in;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      return { ok: true, value: {} };
    }

    const normalized = {};
    for (const [label, prefixes] of Object.entries(mapping)) {
      if (!Array.isArray(prefixes)) {
        continue;
      }

      const cleaned = prefixes
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      if (cleaned.length > 0) {
        normalized[label] = cleaned;
      }
    }

    return { ok: true, value: normalized };
  } catch (error) {
    return { ok: false, type: "check_failed", message: `Unable to parse .agents/.airc.json: ${error.message}` };
  }
}

// === GitHub API ===

function normalizeIssuePayload(payload) {
  return {
    state: String(payload?.state || "").toUpperCase(),
    labels: Array.isArray(payload?.labels) ? payload.labels : [],
    body: typeof payload?.body === "string" ? payload.body : "",
    milestone: payload?.milestone ?? null
  };
}

function resolveUpstreamRepo(taskDir) {
  const ownerRepo = resolveOwnerRepo(taskDir);
  if (!ownerRepo.ok) {
    return ownerRepo;
  }

  const repoResult = ghJson([
    "api",
    `repos/${ownerRepo.value}`
  ], taskDir);

  if (!repoResult.ok) {
    return repoResult;
  }

  const repo = repoResult.value && typeof repoResult.value === "object" ? repoResult.value : {};
  const upstreamRepo = repo.fork ? repo.parent?.full_name : repo.full_name;
  if (isBlank(upstreamRepo)) {
    return { ok: false, message: "Unable to resolve upstream repository" };
  }

  return { ok: true, value: upstreamRepo };
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

function detectPermissions(upstreamRepo, taskDir) {
  const permissionsResult = ghJson([
    "api",
    `repos/${upstreamRepo}`,
    "--jq",
    ".permissions"
  ], taskDir);

  if (!permissionsResult.ok) {
    return { hasTriage: false, hasPush: false };
  }

  const permissions = permissionsResult.value && typeof permissionsResult.value === "object"
    ? permissionsResult.value
    : {};

  return {
    hasTriage: permissions.triage === true,
    hasPush: permissions.push === true
  };
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

function interpolate(template, taskDir, artifactFile) {
  const artifactStem = artifactFile ? path.basename(artifactFile, path.extname(artifactFile)) : "";
  return template
    .replace(/\{task-id\}/g, path.basename(taskDir))
    .replace(/\{artifact-stem\}/g, artifactStem);
}
