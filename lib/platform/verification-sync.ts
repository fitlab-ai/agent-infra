import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { resolvePlatformProviderContext } from "./context.ts";
import { hasCheckedRequirement, resolveRequirementSection } from "./issue-metadata.ts";
import { requirementSectionAnchors } from "./issues.ts";
import { taskTypeLabel } from "./metadata-labels.ts";
import { planInLabelUpdate, validateInLabelMapping, validateRepositoryLabelPayload } from "./in-label-sync.ts";
import { inspectGitHubPullRequest } from "./pull-requests.ts";
import { readPrDeliveryFact } from "../task/pr-delivery-fact.ts";
import { providerError, providerOperationContext, resourceIdentityNumber, unsupportedProviderOperation } from "./provider-bridge.ts";
import { taskIssueIdentity } from "./task-identities.ts";

const CHECK_TYPE = "platform-sync";
const VERSION_LINE_REGEX = /^[0-9]+\.[0-9]+\.x$/;
const FRONTMATTER_FIELD_MAP = {
  priority: "Priority",
  effort: "Effort",
  start_date: "Start date",
  target_date: "Target date"
};
const OPTION_LOCALIZATION: Record<string, string> = {
  "紧急": "Urgent",
  "高": "High",
  "中": "Medium",
  "低": "Low"
};

let activeShared: any = null;
let repoRoot = "";

export function getDefaults(): any {
  return {
    statusLabels: {
      pendingDesignWork: "status: pending-design-work",
      inProgress: "status: in-progress",
      blocked: "status: blocked",
      completed: "status: completed",
      waitingForTriage: "status: waiting-for-triage"
    },
    markers: {
      task: "<!-- sync-issue:{task-id}:task -->",
      artifact: "<!-- sync-issue:{task-id}:{artifact-stem} -->",
      artifactChunk: "<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->",
      summary: "<!-- sync-issue:{task-id}:summary -->",
      cancel: "<!-- sync-issue:{task-id}:cancel -->",
      prSummary: "<!-- sync-pr:{task-id}:summary -->"
    }
  };
}

function getShared(): any {
  if (!activeShared) {
    throw new Error("platform-sync adapter shared utilities are unavailable");
  }

  return activeShared;
}

function loadTask(...args: any[]): any {
  return getShared().loadTask(...args);
}

function getCheckedRequirements(...args: any[]): any {
  return getShared().getCheckedRequirements(...args);
}

function normalizeContent(...args: any[]): any {
  return getShared().normalizeContent(...args);
}

function isBlank(...args: any[]): any {
  return getShared().isBlank(...args);
}

function escapeRegExp(...args: any[]): any {
  return getShared().escapeRegExp(...args);
}

function passResult(...args: any[]): any {
  return getShared().passResult(...args);
}

function failResult(...args: any[]): any {
  return getShared().failResult(...args);
}

function blockedResult(...args: any[]): any {
  return getShared().blockedResult(...args);
}

function safeStat(...args: any[]): any {
  return getShared().safeStat(...args);
}

export async function check({ taskDir, config, artifactFile }: any, shared: any): Promise<any> {
  activeShared = shared;
  repoRoot = shared.repoRoot;
  const context = await buildSyncContext({ taskDir, config, artifactFile });
  if (context.earlyReturn) {
    return context.earlyReturn;
  }

  const remoteData = await fetchRemoteData(context);
  if (remoteData.earlyReturn) {
    return remoteData.earlyReturn;
  }

  const subChecks = [
    checkClosedIssueStatusLabels,
    checkStatusLabel,
    checkCommentMarker,
    checkPrCommentMarker,
    checkPrCommentLastCommit,
    checkPrCommentRequiredPatterns,
    checkCommentContent,
    checkTaskCommentContent,
    checkInLabelsComputed,
    checkPrTypeLabel,
    checkInLabelsMatchPr,
    checkPrAssignee,
    checkSyncedRequirements,
    checkIssueType,
    checkIssueFields,
    checkMilestone
  ];

  for (const subCheck of subChecks) {
    const result = subCheck(context, remoteData);
    if (result) {
      return result;
    }
  }

  return passResult(CHECK_TYPE, `Platform sync checks passed for Issue ${context.issueNumber || "identity"}`);
}

async function buildSyncContext({ taskDir, config, artifactFile }: any): Promise<any> {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return { earlyReturn: failResult(CHECK_TYPE, task.message) };
  }

  const issueIdentity = taskIssueIdentity(task.metadata);
  const issueNumber = resourceIdentityNumber(issueIdentity);
  const fact = readPrDeliveryFact(task.metadata);
  if (fact.status === "invalid") {
    return { earlyReturn: failResult(CHECK_TYPE, fact.error.message, "check_failed") };
  }
  const prIdentity = fact.status === "valid" && fact.fact.state === "bound" ? fact.fact.identity.resource : null;
  const prNumber = resourceIdentityNumber(prIdentity);
  if (config.when === "issue_number_exists" && !issueIdentity) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: task has no issue_number") };
  }
  if (config.when === "pr_fact_bound" && !prIdentity) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: task has no verified bound pull request") };
  }

  if (!issueIdentity) {
    return { earlyReturn: passResult(CHECK_TYPE, "Skipped: platform-sync not required for this task") };
  }

  const loaded = await resolvePlatformProviderContext({ cwd: repoRoot });
  const platformContext = loaded.ok ? loaded.value.context : loaded.context;
  if (platformContext.status === "failed") {
    return { earlyReturn: failResult(CHECK_TYPE, platformContext.error?.message || "Platform context failed", "check_failed") };
  }
  if (platformContext.status === "blocked") {
    return { earlyReturn: blockedResult(CHECK_TYPE, platformContext.error?.message || "Platform context blocked", "network_error") };
  }
  if (!platformContext.platform.repository) {
    if (platformContext.error?.code === "REMOTE_MISSING" || platformContext.error?.code === "REMOTE_INVALID") {
      return { earlyReturn: blockedResult(CHECK_TYPE, platformContext.error.message, "network_error") };
    }
    return { earlyReturn: passResult(CHECK_TYPE, `Skipped: ${platformContext.error?.message || "platform unavailable"}`) };
  }
  const expectedValues = resolveExpectedValues(config);
  if (!expectedValues.ok) {
    return { earlyReturn: failResult(CHECK_TYPE, expectedValues.message, "check_failed") };
  }

  const marker = expectedValues.commentMarker
    ? interpolate(expectedValues.commentMarker, taskDir, artifactFile)
    : null;
  const prMarker = expectedValues.prCommentMarker
    ? interpolate(expectedValues.prCommentMarker, taskDir, artifactFile)
    : null;
  const artifactPath = artifactFile ? path.join(taskDir, artifactFile) : null;

  return {
    task,
    taskDir,
    config,
    artifactFile,
    artifactPath,
    issueIdentity,
    prIdentity,
    issueNumber,
    prNumber,
    upstreamRepo: platformContext.platform.repository,
    repoOwnerType: String(loaded.ok ? loaded.value.snapshot.metadata?.ownerType || "unknown" : "unknown"),
    hasTriage: platformContext.capabilities.triage,
    hasPush: platformContext.capabilities.push,
    expectedStatusLabel: expectedValues.statusLabel,
    marker,
    prMarker,
    provider: loaded.ok ? loaded.value.provider : null,
    providerType: loaded.ok ? loaded.value.providerType : null,
    loadedContext: loaded.ok ? loaded.value : null
  };
}

function resolveExpectedValues(config: any): any {
  const defaults = getDefaults();
  const statusLabel = resolveDefaultValue({
    collection: defaults.statusLabels,
    key: config.expected_status_label_key,
    value: config.expected_status_label,
    configKey: "expected_status_label_key"
  });
  if (!statusLabel.ok) {
    return statusLabel;
  }

  const commentMarker = resolveDefaultValue({
    collection: defaults.markers,
    key: config.expected_comment_marker_key,
    value: config.expected_comment_marker,
    configKey: "expected_comment_marker_key"
  });
  if (!commentMarker.ok) {
    return commentMarker;
  }

  const prCommentMarker = resolveDefaultValue({
    collection: defaults.markers,
    key: config.expected_pr_comment_marker_key,
    value: config.expected_pr_comment_marker,
    configKey: "expected_pr_comment_marker_key"
  });
  if (!prCommentMarker.ok) {
    return prCommentMarker;
  }

  return {
    ok: true,
    statusLabel: statusLabel.value,
    commentMarker: commentMarker.value,
    prCommentMarker: prCommentMarker.value
  };
}

function resolveDefaultValue({ collection, key, value, configKey }: any): any {
  if (!key) {
    return { ok: true, value: value || null };
  }

  const resolvedValue = collection[key];
  if (!resolvedValue) {
    return { ok: false, message: `Unknown ${configKey}: ${key}` };
  }

  return { ok: true, value: resolvedValue };
}

async function fetchRemoteData(context: any): Promise<any> {
  const provider = context.provider;
  const operationContext = providerOperationContext(context.loadedContext, context.taskDir);
  const facts = provider?.verification?.fetchRemoteFacts
    ? await provider.verification.fetchRemoteFacts({
      context: operationContext,
      taskId: context.task?.metadata?.id || context.task?.id || "",
      ...(context.issueIdentity ? { issue: context.issueIdentity } : {}),
      ...(context.prIdentity ? { changeRequest: context.prIdentity } : {}),
      includeComments: shouldFetchComments(context.config),
      includeFields: Boolean(context.config.verify_issue_fields)
    })
    : unsupportedProviderOperation(provider, "verification.fetchRemoteFacts");
  if (!facts.ok) {
    return {
      earlyReturn: facts.error.retryable
        ? blockedResult(CHECK_TYPE, providerError(facts.error, "PLATFORM_PROVIDER_OPERATION_FAILED").message, "network_error")
        : failResult(CHECK_TYPE, providerError(facts.error, "PLATFORM_PROVIDER_OPERATION_FAILED").message, "check_failed")
    };
  }
  const issueSnapshot = facts.value.issue;
  const issue = issueSnapshot
    ? {
      state: issueSnapshot.state.toUpperCase(),
      labels: issueSnapshot.labels.map((name: string) => ({ name })),
      body: issueSnapshot.body,
      milestone: issueSnapshot.milestone ? { title: issueSnapshot.milestone } : null
    }
    : null;
  let issueFields: any;
  if (context.config.verify_issue_fields && issueSnapshot?.issueType) {
    const fieldKinds = new Map(issueSnapshot.issueType.fields.map((field: { name: string; kind: string }) => [field.name, field.kind]));
    issueFields = {
      pinnedNames: new Set(issueSnapshot.issueType.fields.map((field: { name: string }) => field.name)),
      values: new Map(Object.entries(issueSnapshot.fields).map(([name, value]) => [name, { kind: fieldKinds.get(name) || (typeof value === "number" ? "number" : "single-select"), value }]))
    };
  }
  let prComments = null;
  if (context.prMarker && context.prIdentity && shouldFetchComments(context.config) && provider?.comments?.list) {
    const listed = await provider.comments.list({ context: operationContext, parent: context.prIdentity });
    if (!listed.ok) return {
      earlyReturn: listed.error.retryable
        ? blockedResult(CHECK_TYPE, listed.error.message, "network_error")
        : failResult(CHECK_TYPE, listed.error.message, "check_failed")
    };
    prComments = listed.value.map((comment: { id: string; body: string }) => ({ id: comment.id, body: comment.body }));
  }
  const changeRequest = facts.value.changeRequest;
  return {
    issue,
    comments: facts.value.comments.map((comment: { id: string; body: string }) => ({ id: comment.id, body: comment.body })),
    prComments,
    prLabels: changeRequest?.labels || null,
    issueType: issueSnapshot
      ? (issueSnapshot.issueType ? issueSnapshot.issueType.name : null)
      : undefined,
    issueFields,
    prMilestone: changeRequest
      ? (changeRequest.milestone ? { title: changeRequest.milestone } : null)
      : undefined,
    prAssignees: changeRequest?.assignees,
    prHeadSha: changeRequest?.headSha
  };
}

function mapTaskTypeToLabel(taskType: any): any {
  return taskTypeLabel(taskType);
}

function shouldFetchComments(config: any): any {
  return Boolean(
    config.expected_comment_marker
    || config.expected_comment_marker_key
    || config.expected_pr_comment_marker
    || config.expected_pr_comment_marker_key
    || config.verify_pr_comment_last_commit_matches_head
    || config.verify_comment_content
    || config.verify_task_comment_content
  );
}

function checkStatusLabel(context: any, remoteData: any): any {
  if (!context.expectedStatusLabel || !context.hasTriage) {
    return null;
  }

  if (String(remoteData.issue.state || "").toUpperCase() !== "OPEN") {
    return null;
  }

  const labels = extractLabelNames(remoteData.issue.labels);
  if (labels.includes(context.expectedStatusLabel)) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `Expected label '${context.expectedStatusLabel}' not found on Issue #${context.issueNumber}`,
    "check_failed"
  );
}

function checkClosedIssueStatusLabels(context: any, remoteData: any): any {
  if (!context.config.verify_closed_issue_has_no_status_labels) {
    return null;
  }

  if (String(remoteData.issue.state || "").toUpperCase() !== "CLOSED") {
    return null;
  }

  const statusLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("status:"));
  if (statusLabels.length === 0) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `Closed Issue #${context.issueNumber} retains status labels: ${statusLabels.join(", ")}`,
    "check_failed"
  );
}

function checkCommentMarker(context: any, remoteData: any): any {
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

function checkPrCommentMarker(context: any, remoteData: any): any {
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

function checkPrCommentLastCommit(context: any, remoteData: any): any {
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

  const expectedHead = String(remoteData.prHeadSha || "").trim();
  if (!expectedHead) return blockedResult(CHECK_TYPE, "Unable to resolve the PR head SHA", "network_error");
  const actualHead = match[1]!.trim();
  if (expectedHead === actualHead) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `PR #${context.prNumber} summary comment last-commit metadata mismatch: expected ${expectedHead}, got ${actualHead}`,
    "check_failed"
  );
}

function checkPrCommentRequiredPatterns(context: any, remoteData: any): any {
  const patterns = context.config.expected_pr_comment_required_patterns || [];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return null;
  }

  if (!context.prMarker) {
    return failResult(CHECK_TYPE,
      "expected_pr_comment_required_patterns requires expected_pr_comment_marker",
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

  const body = String(comment.body || "");
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "m");
    if (!regex.test(body)) {
      return failResult(CHECK_TYPE,
        `PR #${context.prNumber} summary comment is missing required pattern: ${pattern}`,
        "check_failed"
      );
    }
  }

  return null;
}

function checkCommentContent(context: any, remoteData: any): any {
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

function checkTaskCommentContent(context: any, remoteData: any): any {
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

function checkPrTypeLabel(context: any, remoteData: any): any {
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

function checkInLabelsMatchPr(context: any, remoteData: any): any {
  if (!context.config.verify_in_labels_match_pr || !context.hasTriage || !context.prNumber || !remoteData.prLabels) {
    return null;
  }

  const issueInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("in:"))
    .sort();
  const prInLabels = remoteData.prLabels
    .filter((label: any) => label.startsWith("in:"))
    .sort();

  if (arraysEqual(issueInLabels, prInLabels)) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `in: labels mismatch — PR #${context.prNumber} has [${formatLabelList(prInLabels)}], Issue #${context.issueNumber} has [${formatLabelList(issueInLabels)}]`,
    "check_failed"
  );
}

function checkInLabelsComputed(context: any, remoteData: any): any {
  if (!context.config.verify_in_labels_computed || !context.hasTriage) {
    return null;
  }

  const expectedInLabels = computeExpectedInLabels(context.taskDir, context.upstreamRepo);
  if (!expectedInLabels.ok) {
    return expectedInLabels.type === "check_failed"
      ? failResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type)
      : blockedResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type);
  }

  if (expectedInLabels.mode === "skipped") {
    return null;
  }

  const actualInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("in:"))
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

function checkSyncedRequirements(context: any, remoteData: any): any {
  if (!context.config.sync_checked_requirements || !context.hasTriage) {
    return null;
  }

  const checkedRequirements = getCheckedRequirements(context.task.content);
  if (checkedRequirements.length === 0) {
    return null;
  }

  const issueBody = remoteData.issue.body || "";
  const resolution = resolveRequirementSection(
    issueBody,
    requirementSectionAnchors(repoRoot, context.task.metadata.type || "task")
  );
  if (resolution.status === "missing") {
    return null;
  }
  if (resolution.status === "ambiguous") {
    return failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} requirements section is ambiguous`,
      "check_failed"
    );
  }
  const requirementBody = issueBody.slice(resolution.bodyStart, resolution.bodyEnd);
  const missingRequirements = checkedRequirements.filter(
    (item: any) => !hasCheckedRequirement(requirementBody, item)
  );
  if (missingRequirements.length === 0) {
    return null;
  }

  return failResult(CHECK_TYPE,
    `Issue body is missing checked requirements: ${missingRequirements.join(", ")}`,
    "check_failed"
  );
}

function checkIssueType(context: any, remoteData: any): any {
  if (!context.config.verify_issue_type || !context.hasPush) {
    return null;
  }

  if (remoteData.issueType === undefined) {
    return null;
  }

  if (!remoteData.issueType) {
    if (context.repoOwnerType === "User") {
      return null;
    }

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

function checkIssueFields(context: any, remoteData: any): any {
  if (!context.config.verify_issue_fields || !context.hasPush) {
    return null;
  }

  if (remoteData.issueFields === undefined) {
    return null;
  }

  for (const [metadataKey, fieldName] of Object.entries(FRONTMATTER_FIELD_MAP)) {
    const expectedRaw = context.task.metadata[metadataKey];
    if (isBlank(expectedRaw) || !remoteData.issueFields.pinnedNames.has(fieldName)) {
      continue;
    }

    const actual = remoteData.issueFields.values.get(fieldName);
    const expected = normalizeExpectedIssueField(metadataKey, expectedRaw);
    if (!expected) {
      continue;
    }

    if (!actual) {
      return failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} field '${fieldName}' is missing, expected '${expected.value}'`,
        "check_failed"
      );
    }

    if (actual.kind !== expected.kind || actual.value !== expected.value) {
      return failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} field '${fieldName}' is '${actual.value}', expected '${expected.value}'`,
        "check_failed"
      );
    }
  }

  return null;
}

function checkPrAssignee(context: any, remoteData: any): any {
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

function checkMilestone(context: any, remoteData: any): any {
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

  if (context.config.verify_milestone_specific) {
    const issueTitle = remoteData.issue.milestone.title;
    if (VERSION_LINE_REGEX.test(issueTitle)) {
      return failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} milestone '${issueTitle}' is a release line; narrow to a specific version (e.g. ${issueTitle.replace(/\.x$/, ".N")}) before continuing`,
        "check_failed"
      );
    }
    if (context.prNumber && remoteData.prMilestone?.title && VERSION_LINE_REGEX.test(remoteData.prMilestone.title)) {
      return failResult(CHECK_TYPE,
        `PR #${context.prNumber} milestone '${remoteData.prMilestone.title}' is a release line; narrow to a specific version before continuing`,
        "check_failed"
      );
    }
  }

  return null;
}

function findCommentByMarker(comments: any, marker: any): any {
  return (comments || []).find((comment: any) => typeof comment.body === "string" && comment.body.includes(marker)) || null;
}

function isGeneratedMarkerLine(line: any): any {
  return line.startsWith("<!--") && line.endsWith("-->");
}

function extractCommentBody(commentBody: any): any {
  const lines = String(commentBody || "").split(/\r?\n/);

  let start = 0;
  while (start < lines.length && (lines[start]!.trim() === "" || isGeneratedMarkerLine(lines[start]!.trim()))) {
    start += 1;
  }

  if (start < lines.length && lines[start]!.startsWith("## ")) {
    start += 1;
  }

  while (start < lines.length && lines[start]!.trim() === "") {
    start += 1;
  }

  if (start < lines.length && /^> \*\*.+\*\* · .+$/.test(lines[start]!.trim())) {
    start += 1;
  }

  while (start < lines.length && lines[start]!.trim() === "") {
    start += 1;
  }

  let end = lines.length;
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed === "") {
      continue;
    }

    if (/^\*.*\*$/.test(trimmed)) {
      end = index;
      if (end > start && lines[end - 1]!.trim() === "---") {
        end -= 1;
      }
    }
    break;
  }

  return lines.slice(start, end).join("\n");
}

function buildExpectedTaskBody(taskContent: any): any {
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

function buildTaskFrontmatterSummary(): any {
  const language = loadProjectLanguage();
  if (language === "en" || language === "en-US") {
    return "<details><summary>Metadata (frontmatter)</summary>";
  }

  return "<details><summary>元数据 (frontmatter)</summary>";
}

function loadProjectLanguage(): any {
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

function buildCommentContentMismatchMessage(fileStem: any, issueNumber: any, localContent: any, commentContent: any): any {
  const diffIndex = firstDifferenceIndex(localContent, commentContent);
  const position = indexToLineColumn(localContent, diffIndex);

  return `Comment content mismatch for '${fileStem}' on Issue #${issueNumber}: local file has ${localContent.length} chars, comment body has ${commentContent.length} chars (first difference near char ${diffIndex + 1}, line ${position.line}, column ${position.column})`;
}

function firstDifferenceIndex(left: any, right: any): any {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }

  return limit;
}

function indexToLineColumn(text: any, index: any): any {
  const prefix = text.slice(0, Math.min(index, text.length));
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1) || "").length + 1
  };
}

function extractLabelNames(labels: any): any {
  return (labels || [])
    .map((label: any) => typeof label === "string" ? label : label?.name)
    .filter((label: any) => typeof label === "string" && label.length > 0);
}

function mapTaskTypeToIssueType(taskType: any): any {
  const mapping: Record<string, string> = {
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

function normalizeIssueFields(payload: any): any {
  const issue = payload?.data?.repository?.issue;
  const pinnedFields = Array.isArray(issue?.issueType?.pinnedFields)
    ? issue.issueType.pinnedFields
    : [];
  const values = Array.isArray(issue?.issueFieldValues?.nodes)
    ? issue.issueFieldValues.nodes
    : [];
  const pinnedNames = new Set(
    pinnedFields
      .map((field: any) => typeof field?.name === "string" ? field.name : "")
      .filter(Boolean)
  );
  const normalizedValues = new Map();

  for (const value of values) {
    const fieldName = value?.field?.name;
    if (!fieldName) {
      continue;
    }

    if (value.__typename === "IssueFieldSingleSelectValue") {
      normalizedValues.set(fieldName, {
        kind: "single-select",
        value: normalizeOptionName(value.name)
      });
    } else if (value.__typename === "IssueFieldDateValue") {
      normalizedValues.set(fieldName, {
        kind: "date",
        value: normalizeDateValue(value.value)
      });
    }
  }

  return { pinnedNames, values: normalizedValues };
}

function normalizeExpectedIssueField(metadataKey: any, rawValue: any): any {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  if (metadataKey === "start_date" || metadataKey === "target_date") {
    return { kind: "date", value: normalizeDateValue(value) };
  }

  return { kind: "single-select", value: normalizeOptionName(value) };
}

function normalizeOptionName(value: any): any {
  const normalized = String(value || "").trim();
  return OPTION_LOCALIZATION[normalized] || normalized;
}

function normalizeDateValue(value: any): any {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : normalized;
}

function arraysEqual(left: any, right: any): any {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value: any, index: any) => value === right[index]);
}

function formatLabelList(labels: any): any {
  return labels.length > 0 ? labels.join(", ") : "none";
}

function computeExpectedInLabels(taskDir: any, repository: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return task;
  }
  const baseRef = String(task.metadata?.delivery_base_ref || "").trim();
  if (!baseRef) {
    return { ok: false, type: "check_failed", message: "Task has no delivery_base_ref for in-label evidence" };
  }
  const changedFilesResult = gitText(["diff", `${baseRef}...HEAD`, "--name-only"], taskDir);
  if (!changedFilesResult.ok) {
    return { ...changedFilesResult, type: "network_error" };
  }

  const changedFiles = String(changedFilesResult.value || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  const mapping = loadInLabelMapping();
  if (!mapping.ok) {
    return mapping;
  }

  if (Object.keys(mapping.value ?? {}).length === 0) {
    return { ok: true, labels: [], mode: "mapped" };
  }

  const repoLabelsResult = withRetry(() => ghPaginatedJson([
    "api", "--paginate", "--slurp", `repos/${repository}/labels?per_page=100`
  ], taskDir));
  if (!repoLabelsResult.ok) {
    return repoLabelsResult;
  }

  const repositoryLabels = validateRepositoryLabelPayload(repoLabelsResult.value);
  if (!repositoryLabels.ok) {
    return { ok: false, type: "check_failed", message: repositoryLabels.error.message };
  }
  const planned = planInLabelUpdate({
    changedFiles,
    currentLabels: [],
    mapping: mapping.value ?? {},
    repositoryLabels: new Set(repositoryLabels.value)
  });
  if (planned.error) {
    return { ok: false, type: "check_failed", message: planned.error.message };
  }
  return { ok: true, labels: planned.target, mode: "mapped" };
}

function loadInLabelMapping(): any {
  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    return { ok: true, value: {} };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const mapping = validateInLabelMapping(config?.labels?.in);
    return mapping.ok
      ? { ok: true, value: mapping.value }
      : { ok: false, type: "check_failed", message: mapping.error.message };
  } catch (error: any) {
    return { ok: false, type: "check_failed", message: `Unable to parse .agents/.airc.json: ${error.message}` };
  }
}

// === GitHub API ===

function gitText(args: any, cwd: any): any {
  try {
    const value = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, value: String(value || "").trim() };
  } catch (error: any) {
    const stderr = `${error?.stderr || ""}${error?.stdout || ""}`.trim();
    return {
      ok: false,
      type: "check_failed",
      message: stderr || `git ${args.join(" ")} failed`
    };
  }
}

function resolvePrHeadSha(context: any): any {
  const fallback = () => withRetry(() => gitText(["rev-parse", "HEAD"], context.taskDir));
  const branch = String(context.task?.metadata?.branch || "").trim();
  if (!branch) {
    return fallback();
  }

  const worktreeList = withRetry(() => gitText(["worktree", "list", "--porcelain"], context.taskDir));
  if (!worktreeList.ok) {
    return fallback();
  }

  const matchedWorktree = findWorktreeForBranch(worktreeList.value, branch);
  if (!matchedWorktree) {
    return fallback();
  }

  const headInWorktree = withRetry(() => gitText(["rev-parse", "HEAD"], matchedWorktree));
  if (!headInWorktree.ok) {
    return fallback();
  }

  return headInWorktree;
}

function findWorktreeForBranch(porcelainOutput: any, branch: any): any {
  let currentWorktree = "";
  for (const rawLine of String(porcelainOutput || "").split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length).trim();
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      const usedBranch = line.slice("branch refs/heads/".length).trim();
      if (usedBranch === branch && currentWorktree) {
        return currentWorktree;
      }
    }
  }

  return null;
}

function withRetry(operation: any): any {
  return operation();
}

function interpolate(template: any, taskDir: any, artifactFile: any): any {
  const artifactStem = artifactFile ? path.basename(artifactFile, path.extname(artifactFile)) : "";
  return template
    .replace(/\{task-id\}/g, path.basename(taskDir))
    .replace(/\{artifact-stem\}/g, artifactStem);
}
