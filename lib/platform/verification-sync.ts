import type { VerificationShared } from "../task/verification-types.ts";
import { normalizeVerificationRecord, platformAuditPolicy, type PlatformAuditId } from "../task/gate-policy.ts";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { resolvePlatformProviderContext } from "./context.ts";
import { hasCheckedRequirement, resolveRequirementSection } from "./issue-metadata.ts";
import { requirementSectionAnchors } from "./issues.ts";
import { taskTypeLabel } from "./metadata-labels.ts";
import { planInLabelUpdate, validateInLabelMapping } from "./in-label-sync.ts";
import { readPrDeliveryFact } from "../task/pr-delivery-fact.ts";
import { providerError, providerOperationContext, resourceIdentityNumber, unsupportedProviderOperation } from "./provider-bridge.ts";
import { taskIssueIdentity } from "./task-identities.ts";
import { MARKERS, renderTaskCommentResult } from "./issue-comments.ts";
import {
  CONTROL_MARKER_PATTERN,
  canonicalizeCommentBody,
  renderSafeCodeFence,
  sanitizeMarkdownDocument
} from "./comment-safety.ts";

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

function sanitizeCommentContent(content: string): string | null {
  const result = sanitizeMarkdownDocument(content, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  return result.ok ? result.value : null;
}

function infoResult(message: string): any {
  return {
    type: CHECK_TYPE,
    status: 'pass',
    message,
    classification: 'info',
    reason: 'NOT_APPLICABLE',
    action: 'No action required'
  };
}

function hardResult(result: any): any {
  return { ...result, classification: 'hard' };
}

export async function check({ taskDir, config, artifactFile, skillName }: any, shared: VerificationShared): Promise<any> {
  const context = await buildSyncContext({ taskDir, config, artifactFile, skillName }, shared);
  if (context.earlyReturn) {
    return context.earlyReturn;
  }

  const remoteData = await fetchRemoteData(context, shared);
  if (remoteData.earlyReturn) {
    return remoteData.earlyReturn;
  }

  const subChecks = [
    ['closed-status-labels', checkClosedIssueStatusLabels], ['status-label', checkStatusLabel],
    ['comment-marker', checkCommentMarker], ['pr-comment-marker', checkPrCommentMarker],
    ['pr-comment-last-commit', checkPrCommentLastCommit], ['pr-comment-content', checkPrCommentRequiredPatterns],
    ['comment-content', checkCommentContent], ['task-comment-content', checkTaskCommentContent],
    ['in-labels-computed', checkInLabelsComputed], ['pr-type-label', checkPrTypeLabel],
    ['in-labels-match-pr', checkInLabelsMatchPr], ['pr-assignee', checkPrAssignee],
    ['requirements', checkSyncedRequirements], ['issue-type', checkIssueType],
    ['issue-fields', checkIssueFields], ['milestone', checkMilestone]
  ] as const;
  const results = subChecks.map(([id, subCheck]) => {
    const audit = platformAuditPolicy(id as PlatformAuditId, context);
    const result = subCheck({ ...context, audit }, remoteData, shared) ?? infoResult(`Platform audit '${id}' was not evaluated`);
    return { ...result, checkId: `platform.${id}`, classification: result.classification ?? audit.classification };
  });
  const blocking = results.map(normalizeVerificationRecord).find((result) => result.effectiveStatus !== 'pass');
  return {
    ...(blocking
      ? {
          type: CHECK_TYPE,
          status: blocking.effectiveStatus,
          message: blocking.message,
          ...(blocking.fail_type ? { fail_type: blocking.fail_type } : {}),
          classification: 'hard'
        }
      : shared.passResult(CHECK_TYPE, `Platform sync audits completed for Issue ${context.issueNumber || "identity"}`)),
    subchecks: results
  };
}

async function buildSyncContext({ taskDir, config, artifactFile, skillName }: any, shared: VerificationShared): Promise<any> {
  const task = shared.loadTask(taskDir);
  if (!task.ok) {
    return { earlyReturn: shared.failResult(CHECK_TYPE, task.message) };
  }

  const issueIdentity = taskIssueIdentity(task.metadata);
  const issueNumber = resourceIdentityNumber(issueIdentity);
  const fact = readPrDeliveryFact(task.metadata);
  if (fact.status === "invalid") {
    return { earlyReturn: shared.failResult(CHECK_TYPE, fact.error.message, "check_failed") };
  }
  const prIdentity = fact.status === "valid" && fact.fact.state === "bound" ? fact.fact.identity.resource : null;
  const prNumber = resourceIdentityNumber(prIdentity);
  if (config.when === "platform_issue_identity_exists" && !issueIdentity) {
    return { earlyReturn: shared.passResult(CHECK_TYPE, "Skipped: task has no platform_issue_identity") };
  }
  if (config.when === "pr_fact_bound" && !prIdentity) {
    return { earlyReturn: shared.passResult(CHECK_TYPE, "Skipped: task has no verified bound pull request") };
  }

  if (!issueIdentity) {
    return { earlyReturn: shared.passResult(CHECK_TYPE, "Skipped: platform-sync not required for this task") };
  }

  const loaded = await resolvePlatformProviderContext({ cwd: shared.repoRoot });
  const platformContext = loaded.ok ? loaded.value.context : loaded.context;
  if (platformContext.status === "failed") {
    return { earlyReturn: shared.failResult(CHECK_TYPE, platformContext.error?.message || "Platform context failed", "check_failed") };
  }
  if (platformContext.status === "blocked") {
    return { earlyReturn: shared.blockedResult(CHECK_TYPE, platformContext.error?.message || "Platform context blocked", "network_error") };
  }
  if (!platformContext.platform.repository) {
    if (platformContext.error?.code === "REMOTE_MISSING" || platformContext.error?.code === "REMOTE_INVALID") {
      return { earlyReturn: shared.blockedResult(CHECK_TYPE, platformContext.error.message, "network_error") };
    }
    return { earlyReturn: shared.passResult(CHECK_TYPE, `Skipped: ${platformContext.error?.message || "platform unavailable"}`) };
  }
  const effectiveSkillName = skillName || config.skillName || "code-task";
  const expectedValues = resolveExpectedValues(effectiveSkillName, artifactFile);
  if (!expectedValues.ok) {
    return { earlyReturn: shared.failResult(CHECK_TYPE, expectedValues.message, "check_failed") };
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
    skillName: effectiveSkillName,
    artifactFile,
    artifactPath,
    issueIdentity,
    prIdentity,
    issueNumber,
    prNumber,
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

function resolveExpectedValues(skillName: string, artifactFile: string | undefined): any {
  const defaults = getDefaults();
  const statusPolicy = platformAuditPolicy('status-label', { skillName, artifactFile });
  const commentPolicy = platformAuditPolicy('comment-marker', { skillName, artifactFile });
  const prCommentPolicy = ['pr-comment-marker', 'pr-comment-last-commit', 'pr-comment-content']
    .map((id) => platformAuditPolicy(id as PlatformAuditId, { skillName, artifactFile }))
    .find((policy) => policy.enabled && policy.expectedPrCommentMarkerKey);
  return {
    ok: true,
    statusLabel: statusPolicy.enabled ? statusPolicy.expectedStatusLabel || null : null,
    commentMarker: commentPolicy.enabled && commentPolicy.expectedCommentMarkerKey ? defaults.markers[commentPolicy.expectedCommentMarkerKey] : null,
    prCommentMarker: prCommentPolicy?.expectedPrCommentMarkerKey ? defaults.markers[prCommentPolicy.expectedPrCommentMarkerKey] : null
  };
}

async function fetchRemoteData(context: any, shared: VerificationShared): Promise<any> {
  const provider = context.provider;
  const operationContext = providerOperationContext(context.loadedContext, context.taskDir);
  const facts = provider?.verification?.fetchRemoteFacts
    ? await provider.verification.fetchRemoteFacts({
      context: operationContext,
      taskId: context.task?.metadata?.id || context.task?.id || "",
      ...(context.issueIdentity ? { issue: context.issueIdentity } : {}),
      ...(context.prIdentity ? { changeRequest: context.prIdentity } : {}),
      includeComments: shouldFetchIssueComments(context),
      includeFields: true
    })
    : unsupportedProviderOperation(provider, "verification.fetchRemoteFacts");
  if (!facts.ok) {
    return {
      earlyReturn: facts.error.retryable
        ? shared.blockedResult(CHECK_TYPE, providerError(facts.error, "PLATFORM_PROVIDER_OPERATION_FAILED").message, "network_error")
        : shared.failResult(CHECK_TYPE, providerError(facts.error, "PLATFORM_PROVIDER_OPERATION_FAILED").message, "check_failed")
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
  if (issueSnapshot?.issueType) {
    const fieldKinds = new Map(issueSnapshot.issueType.fields.map((field: { name: string; kind: string }) => [field.name, field.kind]));
    issueFields = {
      pinnedNames: new Set(issueSnapshot.issueType.fields.map((field: { name: string }) => field.name)),
      values: new Map(Object.entries(issueSnapshot.fields).map(([name, value]) => [name, { kind: fieldKinds.get(name) || (typeof value === "number" ? "number" : "single-select"), value }]))
    };
  }
  let prComments = null;
  if (context.prMarker && context.prIdentity && shouldFetchPrComments(context) && provider?.comments?.list) {
    const listed = await provider.comments.list({ context: operationContext, parent: context.prIdentity });
    if (!listed.ok) return {
      earlyReturn: listed.error.retryable
        ? shared.blockedResult(CHECK_TYPE, listed.error.message, "network_error")
        : shared.failResult(CHECK_TYPE, listed.error.message, "check_failed")
    };
    prComments = listed.value.map((comment: { id: string; body: string }) => ({ id: comment.id, body: comment.body }));
  }
  const changeRequest = facts.value.changeRequest;
  let inLabelMapping: Record<string, string[]> = {};
  let repositoryLabels: string[] = [];
  if (platformAuditPolicy('in-labels-computed', context).enabled && context.hasTriage) {
    const mapping = loadInLabelMapping(shared);
    if (!mapping.ok) return { earlyReturn: shared.failResult(CHECK_TYPE, mapping.message, "check_failed") };
    inLabelMapping = mapping.value;
    if (Object.keys(inLabelMapping).length > 0) {
      const labels = provider?.issues?.listLabels
        ? await provider.issues.listLabels({ context: operationContext })
        : unsupportedProviderOperation(provider, "issues.listLabels");
      if (!labels.ok) {
        const error = providerError(labels.error, "PLATFORM_PROVIDER_OPERATION_FAILED");
        return {
          earlyReturn: error.retryable
            ? shared.blockedResult(CHECK_TYPE, `${error.code}: ${error.message}`, "network_error")
            : shared.failResult(CHECK_TYPE, `${error.code}: ${error.message}`, "check_failed")
        };
      }
      repositoryLabels = labels.value;
    }
  }
  return {
    issue,
    comments: facts.value.comments.map((comment: { id: string; body: string; createdSequence: number | null }) => ({
      id: comment.id, body: comment.body, createdSequence: comment.createdSequence
    })),
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
    prHeadSha: changeRequest?.headSha,
    inLabelMapping,
    repositoryLabels
  };
}

function mapTaskTypeToLabel(taskType: any): any {
  return taskTypeLabel(taskType);
}

function hasEnabledAudit(context: any, auditIds: PlatformAuditId[]): boolean {
  return auditIds
    .some((id) => platformAuditPolicy(id as PlatformAuditId, context).enabled);
}

function shouldFetchIssueComments(context: any): boolean {
  return hasEnabledAudit(context, ['comment-marker', 'comment-content', 'task-comment-content']);
}

function shouldFetchPrComments(context: any): boolean {
  return hasEnabledAudit(context, ['pr-comment-marker', 'pr-comment-last-commit', 'pr-comment-content']);
}

function checkStatusLabel(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.expectedStatusLabel || !context.hasTriage) {
    return infoResult('Status label audit is not applicable because no expected label or triage capability is available');
  }

  if (String(remoteData.issue.state || "").toUpperCase() !== "OPEN") {
    return infoResult('Status label audit is not applicable because the Issue is closed');
  }

  const labels = extractLabelNames(remoteData.issue.labels);
  if (labels.includes(context.expectedStatusLabel)) {
    return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} has expected status label '${context.expectedStatusLabel}'`);
  }

  return shared.failResult(CHECK_TYPE,
    `Expected label '${context.expectedStatusLabel}' not found on Issue #${context.issueNumber}`,
    "check_failed"
  );
}

function checkClosedIssueStatusLabels(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled) {
    return infoResult('Closed Issue status-label audit is not enabled for this workflow');
  }

  if (String(remoteData.issue.state || "").toUpperCase() !== "CLOSED") {
    return infoResult('Closed Issue status-label audit is not applicable because the Issue is open');
  }

  const statusLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("status:"));
  if (statusLabels.length === 0) {
    return shared.passResult(CHECK_TYPE, `Closed Issue #${context.issueNumber} has no status labels`);
  }

  return shared.failResult(CHECK_TYPE,
    `Closed Issue #${context.issueNumber} retains status labels: ${statusLabels.join(", ")}`,
    "check_failed"
  );
}

function checkCommentMarker(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.marker) {
    return infoResult('Issue comment-marker audit is not applicable because no marker is configured');
  }

  const comment = findCommentByMarker(remoteData.comments, context.marker);
  if (comment) {
    if (context.marker === MARKERS.summary(context.task.metadata.id)) {
      const managed = remoteData.comments.filter((candidate: any) => {
        const first = String(candidate.body || '').replace(/\r\n/g, '\n').split('\n', 1)[0] || '';
        return first === MARKERS.task(context.task.metadata.id)
          || first === MARKERS.summary(context.task.metadata.id)
          || first.startsWith(`<!-- sync-issue:${context.task.metadata.id}:`);
      });
      if (managed.some((candidate: any) => !Number.isSafeInteger(candidate.createdSequence) || candidate.createdSequence < 1)) {
        return shared.failResult(CHECK_TYPE, `Issue #${context.issueNumber} summary comment ordering is not provable`, "check_failed");
      }
      const summarySequence = comment.createdSequence;
      if (!managed.every((candidate: any) => summarySequence >= candidate.createdSequence)) {
        return shared.failResult(CHECK_TYPE, `Issue #${context.issueNumber} summary comment is not last among task-managed comments`, "check_failed");
      }
    }
    return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} has expected comment marker`);
  }

  return shared.failResult(CHECK_TYPE,
    `Expected comment marker '${context.marker}' not found on Issue #${context.issueNumber}`,
    "check_failed"
  );
}

function checkPrCommentMarker(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.prMarker) {
    return infoResult('PR comment-marker audit is not applicable because no marker is configured');
  }

  const comment = findCommentByMarker(remoteData.prComments, context.prMarker);
  if (comment) {
    return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} has expected comment marker`);
  }

  return shared.failResult(CHECK_TYPE,
    `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
    "check_failed"
  );
}

function checkPrCommentLastCommit(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled) {
    return infoResult('PR last-commit audit is not enabled for this workflow');
  }

  if (!context.prMarker) {
    return hardResult(shared.failResult(CHECK_TYPE,
      "verify_pr_comment_last_commit_matches_head requires expected_pr_comment_marker",
      "check_failed"
    ));
  }

  const comment = findCommentByMarker(remoteData.prComments, context.prMarker);
  if (!comment) {
    return hardResult(shared.failResult(CHECK_TYPE,
      `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
      "check_failed"
    ));
  }

  const match = String(comment.body || "").match(/<!--\s*last-commit:\s*([0-9a-f]{7,40})\s*-->/i);
  if (!match) {
    return hardResult(shared.failResult(CHECK_TYPE,
      `PR #${context.prNumber} summary comment is missing '<!-- last-commit: <sha> -->' metadata`,
      "check_failed"
    ));
  }

  const expectedHead = String(remoteData.prHeadSha || "").trim();
  if (!expectedHead) return hardResult(shared.blockedResult(CHECK_TYPE, "Unable to resolve the PR head SHA", "network_error"));
  const actualHead = match[1]!.trim();
  if (expectedHead === actualHead) {
    return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} summary comment last-commit matches HEAD`);
  }

  return hardResult(shared.failResult(CHECK_TYPE,
    `PR #${context.prNumber} summary comment last-commit metadata mismatch: expected ${expectedHead}, got ${actualHead}`,
    "check_failed"
  ));
}

function checkPrCommentRequiredPatterns(context: any, remoteData: any, shared: VerificationShared): any {
  const patterns = context.audit.enabled ? context.config.expected_pr_comment_required_patterns || [] : [];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return infoResult('PR comment-content audit is not enabled for this workflow');
  }

  if (!context.prMarker) {
    return hardResult(shared.failResult(CHECK_TYPE,
      "expected_pr_comment_required_patterns requires expected_pr_comment_marker",
      "check_failed"
    ));
  }

  const comment = findCommentByMarker(remoteData.prComments, context.prMarker);
  if (!comment) {
    return hardResult(shared.failResult(CHECK_TYPE,
      `Expected PR comment marker '${context.prMarker}' not found on PR #${context.prNumber}`,
      "check_failed"
    ));
  }

  const body = String(comment.body || "");
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "m");
    if (!regex.test(body)) {
      return hardResult(shared.failResult(CHECK_TYPE,
        `PR #${context.prNumber} summary comment is missing required pattern: ${pattern}`,
        "check_failed"
      ));
    }
  }

  return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} summary comment has all required patterns`);
}

function checkCommentContent(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled) {
    return infoResult('Artifact comment-content audit is not enabled for this workflow');
  }

  if (!context.marker) {
    return hardResult(shared.failResult(CHECK_TYPE, "Artifact comment-content audit requires an expected comment marker", "check_failed"));
  }

  if (!context.artifactPath || !shared.safeStat(context.artifactPath)) {
    return hardResult(shared.failResult(CHECK_TYPE,
      `Artifact not found for comment verification: ${context.artifactFile || "(missing artifactFile)"}`,
      "check_failed"
    ));
  }

  const comment = findCommentByMarker(remoteData.comments, context.marker);
  let localContent: string;
  let commentContent: string;
  try {
    const localCanonical = canonicalizeCommentBody(fs.readFileSync(context.artifactPath, "utf8"));
    const commentCanonical = canonicalizeCommentBody(extractCommentBody(comment?.body || ""));
    if (!localCanonical.ok) {
      return hardResult(shared.failResult(CHECK_TYPE,
        `Comment content cannot be canonicalized for '${path.basename(context.artifactPath, path.extname(context.artifactPath))}': ${localCanonical.error.message}`,
        "check_failed"
      ));
    }
    if (!commentCanonical.ok) {
      return hardResult(shared.failResult(CHECK_TYPE,
        `Comment content cannot be canonicalized for '${path.basename(context.artifactPath, path.extname(context.artifactPath))}': ${commentCanonical.error.message}`,
        "check_failed"
      ));
    }
    localContent = shared.normalizeContent(localCanonical.value);
    commentContent = shared.normalizeContent(commentCanonical.value);
  } catch (error) {
    return hardResult(shared.failResult(CHECK_TYPE,
      `Comment content cannot be read for '${path.basename(context.artifactPath, path.extname(context.artifactPath))}': ${error instanceof Error ? error.message : String(error)}`,
      "check_failed"
    ));
  }

  if (localContent === commentContent) {
    return shared.passResult(CHECK_TYPE, `Artifact comment content matches Issue #${context.issueNumber}`);
  }

  return shared.failResult(CHECK_TYPE,
    buildCommentContentMismatchMessage(
      path.basename(context.artifactPath, path.extname(context.artifactPath)),
      context.issueNumber,
      localContent,
      commentContent
    ),
    "check_failed"
  );
}

function checkTaskCommentContent(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled) {
    return infoResult('Task comment-content audit is not enabled for this workflow');
  }
  const taskMarker = `<!-- sync-issue:${context.task.metadata.id}:task -->`;
  const comment = findCommentByMarker(remoteData.comments, taskMarker);
  if (!comment) {
    return shared.failResult(CHECK_TYPE,
      `Expected comment marker '${taskMarker}' not found on Issue #${context.issueNumber}`,
      "check_failed"
    );
  }

  let renderedTask: { body: string; byteLength: number };
  try {
    renderedTask = renderTaskCommentResult(
      context.task.content,
      context.task.metadata.id,
      loadProjectLanguage(shared)
    );
  } catch {
    return hardResult(shared.failResult(CHECK_TYPE, "Task content cannot be rendered safely for comment verification", "check_failed"));
  }
  if (renderedTask.byteLength > 60_000) {
    return hardResult(shared.failResult(CHECK_TYPE, "Task comment exceeds the platform byte limit", "check_failed"));
  }
  const expectedBody = shared.normalizeContent(extractCommentBody(renderedTask.body));
  const commentBody = shared.normalizeContent(extractCommentBody(comment.body || ""));

  if (expectedBody === commentBody) {
    return shared.passResult(CHECK_TYPE, `Task comment content matches Issue #${context.issueNumber}`);
  }

  return shared.failResult(CHECK_TYPE,
    buildCommentContentMismatchMessage("task", context.issueNumber, expectedBody, commentBody),
    "check_failed"
  );
}

function checkPrTypeLabel(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.hasTriage || !context.prNumber || !remoteData.prLabels) {
    return infoResult('PR type-label audit is not applicable because the required PR metadata or capability is unavailable');
  }

  const expectedLabel = mapTaskTypeToLabel(context.task.metadata.type);
  if (!expectedLabel) {
    return infoResult('PR type-label audit is not applicable because the task type has no label mapping');
  }

  if (remoteData.prLabels.includes(expectedLabel)) {
    return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} has expected type label '${expectedLabel}'`);
  }

  return shared.failResult(CHECK_TYPE,
    `Expected type label '${expectedLabel}' not found on PR #${context.prNumber}`,
    "check_failed"
  );
}

function checkInLabelsMatchPr(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.hasTriage || !context.prNumber || !remoteData.prLabels) {
    return infoResult('PR in: label audit is not applicable because the required PR metadata or capability is unavailable');
  }

  const issueInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("in:"))
    .sort();
  const prInLabels = remoteData.prLabels
    .filter((label: any) => label.startsWith("in:"))
    .sort();

  if (arraysEqual(issueInLabels, prInLabels)) {
    return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} in: labels match Issue #${context.issueNumber}`);
  }

  return shared.failResult(CHECK_TYPE,
    `in: labels mismatch — PR #${context.prNumber} has [${formatLabelList(prInLabels)}], Issue #${context.issueNumber} has [${formatLabelList(issueInLabels)}]`,
    "check_failed"
  );
}

function checkInLabelsComputed(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.hasTriage) {
    return infoResult('Computed in: label audit is not applicable because it is disabled or triage capability is unavailable');
  }

  const expectedInLabels = computeExpectedInLabels(context.taskDir, remoteData.repositoryLabels, remoteData.inLabelMapping, shared);
  if (!expectedInLabels.ok) {
    return expectedInLabels.type === "check_failed"
      ? shared.failResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type)
      : shared.blockedResult(CHECK_TYPE, expectedInLabels.message, expectedInLabels.type);
  }

  if (expectedInLabels.mode === "skipped") {
    return infoResult('Computed in: label audit is not applicable because no mapped changed path exists');
  }

  const actualInLabels = extractLabelNames(remoteData.issue.labels)
    .filter((label: any) => label.startsWith("in:"))
    .sort();

  if (arraysEqual(expectedInLabels.labels, actualInLabels)) {
    return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} in: labels match committed changes`);
  }

  return shared.failResult(
    CHECK_TYPE,
    `Issue #${context.issueNumber} in: labels do not match committed changes: expected [${formatLabelList(expectedInLabels.labels)}], got [${formatLabelList(actualInLabels)}]`,
    "check_failed"
  );
}

function checkSyncedRequirements(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.hasTriage) {
    return infoResult('Requirements audit is not applicable because it is disabled or triage capability is unavailable');
  }

  const checkedRequirements = shared.getCheckedRequirements(context.task.content);
  if (checkedRequirements.length === 0) {
    return infoResult('Requirements audit is not applicable because the task has no checked requirements');
  }

  const issueBody = remoteData.issue.body || "";
  const resolution = resolveRequirementSection(
    issueBody,
    requirementSectionAnchors(shared.repoRoot, context.task.metadata.type || "task")
  );
  if (resolution.status === "missing") {
    return infoResult('Requirements audit is not applicable because the Issue has no requirements section');
  }
  if (resolution.status === "ambiguous") {
    return hardResult(shared.failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} requirements section is ambiguous`,
      "check_failed"
    ));
  }
  const requirementBody = issueBody.slice(resolution.bodyStart, resolution.bodyEnd);
  const missingRequirements = checkedRequirements.filter(
    (item: any) => !hasCheckedRequirement(requirementBody, item)
  );
  if (missingRequirements.length === 0) {
    return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} contains all checked requirements`);
  }

  return shared.failResult(CHECK_TYPE,
    `Issue body is missing checked requirements: ${missingRequirements.join(", ")}`,
    "check_failed"
  );
}

function checkIssueType(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.hasPush) {
    return infoResult('Issue Type audit is not applicable because push capability is unavailable');
  }

  if (remoteData.issueType === undefined) {
    return infoResult('Issue Type audit is not applicable because the provider does not expose Issue Type');
  }

  if (!remoteData.issueType) {
    if (context.repoOwnerType === "User") {
      return infoResult('Issue Type audit is not applicable for a user-owned repository');
    }

    return shared.failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has no Issue Type set`,
      "check_failed"
    );
  }

  const expectedType = mapTaskTypeToIssueType(context.task.metadata.type);
  if (expectedType && remoteData.issueType !== expectedType) {
    return shared.failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has type '${remoteData.issueType}', expected '${expectedType}' (from task type '${context.task.metadata.type}')`,
      "check_failed"
    );
  }

  return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} has the expected Issue Type`);
}

function checkIssueFields(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.hasPush) {
    return infoResult('Issue field audit is not applicable because push capability is unavailable');
  }

  if (remoteData.issueFields === undefined) {
    return infoResult('Issue field audit is not applicable because the provider does not expose Issue fields');
  }

  for (const [metadataKey, fieldName] of Object.entries(FRONTMATTER_FIELD_MAP)) {
    const expectedRaw = context.task.metadata[metadataKey];
    if (shared.isBlank(expectedRaw) || !remoteData.issueFields.pinnedNames.has(fieldName)) {
      continue;
    }

    const actual = remoteData.issueFields.values.get(fieldName);
    const expected = normalizeExpectedIssueField(metadataKey, expectedRaw);
    if (!expected) {
      continue;
    }

    if (!actual) {
      return shared.failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} field '${fieldName}' is missing, expected '${expected.value}'`,
        "check_failed"
      );
    }

    if (actual.kind !== expected.kind || actual.value !== expected.value) {
      return shared.failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} field '${fieldName}' is '${actual.value}', expected '${expected.value}'`,
        "check_failed"
      );
    }
  }

  return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} fields match task metadata`);
}

function checkPrAssignee(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.audit.enabled || !context.hasPush || !context.prNumber) {
    return infoResult('PR assignee audit is not applicable because it is disabled or required PR metadata/capability is unavailable');
  }

  if (!remoteData.prAssignees || remoteData.prAssignees.length === 0) {
    return shared.failResult(CHECK_TYPE,
      `PR #${context.prNumber} has no assignee`,
      "check_failed"
    );
  }

  return shared.passResult(CHECK_TYPE, `PR #${context.prNumber} has an assignee`);
}

function checkMilestone(context: any, remoteData: any, shared: VerificationShared): any {
  if (!context.hasTriage) {
    return infoResult('Milestone audit is not applicable because triage capability is unavailable');
  }

  if (!remoteData.issue?.milestone?.title) {
    return shared.failResult(CHECK_TYPE,
      `Issue #${context.issueNumber} has no milestone set`,
      "check_failed"
    );
  }

  if (context.prNumber && remoteData.prMilestone !== undefined && !remoteData.prMilestone?.title) {
    return shared.failResult(CHECK_TYPE,
      `PR #${context.prNumber} has no milestone set`,
      "check_failed"
    );
  }

  if (context.audit.requireSpecificMilestone) {
    const issueTitle = remoteData.issue.milestone.title;
    if (VERSION_LINE_REGEX.test(issueTitle)) {
      return shared.failResult(CHECK_TYPE,
        `Issue #${context.issueNumber} milestone '${issueTitle}' is a release line; narrow to a specific version (e.g. ${issueTitle.replace(/\.x$/, ".N")}) before continuing`,
        "check_failed"
      );
    }
    if (context.prNumber && remoteData.prMilestone?.title && VERSION_LINE_REGEX.test(remoteData.prMilestone.title)) {
      return shared.failResult(CHECK_TYPE,
        `PR #${context.prNumber} milestone '${remoteData.prMilestone.title}' is a release line; narrow to a specific version before continuing`,
        "check_failed"
      );
    }
  }

  return shared.passResult(CHECK_TYPE, `Issue #${context.issueNumber} milestone satisfies the configured policy`);
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

  if (start < lines.length && (/^> \*\*.+\*\* · .+$/.test(lines[start]!.trim()) || /^> 任务同步 · .+$/.test(lines[start]!.trim()))) {
    start += 1;
  }

  while (start < lines.length && lines[start]!.trim() === "") {
    start += 1;
  }

  if (lines[start]?.trim() === "<details><summary>恢复元数据</summary>") {
    const metadataEnd = lines.indexOf("</details>", start + 1);
    if (metadataEnd >= 0) {
      start = metadataEnd + 1;
      while (start < lines.length && lines[start]!.trim() === "") {
        start += 1;
      }
    }
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

function buildExpectedTaskBody(taskContent: any, shared: VerificationShared): any {
  const frontmatterMatch = taskContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return sanitizeCommentContent(taskContent.trim());
  }

  const body = sanitizeCommentContent(taskContent.slice(frontmatterMatch[0].length).trim());
  if (body === null) {
    return null;
  }
  return [
    buildTaskFrontmatterSummary(shared),
    "",
    renderSafeCodeFence(frontmatterMatch[0].trim(), "yaml"),
    "",
    "</details>",
    "",
    body
  ].join("\n").trim();
}

function buildTaskFrontmatterSummary(shared: VerificationShared): any {
  const language = loadProjectLanguage(shared);
  if (language === "en" || language === "en-US") {
    return "<details><summary>Metadata (frontmatter)</summary>";
  }

  return "<details><summary>元数据 (frontmatter)</summary>";
}

function loadProjectLanguage(shared: VerificationShared): any {
  const override = process.env.VALIDATE_ARTIFACT_LANGUAGE;
  if (!shared.isBlank(override)) {
    return String(override).trim();
  }

  const configPath = path.join(shared.repoRoot, ".agents", ".airc.json");
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

function computeExpectedInLabels(taskDir: any, repositoryLabels: string[], mappingOverride: Record<string, string[]> | undefined, shared: VerificationShared): any {
  const task = shared.loadTask(taskDir);
  if (!task.ok) {
    return task;
  }
  const baseRef = String(task.metadata?.delivery_base_ref || "").trim();
  if (!baseRef) {
    return { ok: false, type: "check_failed", message: "Task has no delivery_base_ref for in-label evidence" };
  }
  const branch = typeof task.metadata?.branch === "string" ? task.metadata.branch.trim() : "";
  const gitCwd = branch ? worktreeForBranch(shared.repoRoot, branch) ?? taskDir : taskDir;
  const changedFilesResult = gitText(["diff", `${baseRef}...HEAD`, "--name-only"], gitCwd);
  if (!changedFilesResult.ok) {
    return { ...changedFilesResult, type: "network_error" };
  }

  const changedFiles = String(changedFilesResult.value || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  const mapping = mappingOverride ?? {};
  if (Object.keys(mapping).length === 0) {
    return { ok: true, labels: [], mode: "mapped" };
  }

  const planned = planInLabelUpdate({
    changedFiles,
    currentLabels: [],
    mapping,
    repositoryLabels: new Set(repositoryLabels)
  });
  if (planned.error) {
    return { ok: false, type: "check_failed", message: planned.error.message };
  }
  return { ok: true, labels: planned.target, mode: "mapped" };
}

function worktreeForBranch(repositoryRoot: string, branch: string): string | null {
  try {
    const records = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim().split(/\r?\n\r?\n/);
    const expectedRef = `refs/heads/${branch}`;
    for (const record of records) {
      const worktree = /^worktree (.+)$/m.exec(record)?.[1];
      const branchRef = /^branch (.+)$/m.exec(record)?.[1];
      if (worktree && branchRef === expectedRef) return worktree;
    }
  } catch {
    // Fall back to taskDir so ordinary in-repository task workspaces retain their behavior.
  }
  return null;
}

function loadInLabelMapping(shared: VerificationShared): any {
  const configPath = path.join(shared.repoRoot, ".agents", ".airc.json");
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

// === Git working tree ===

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
  const fallback = () => gitText(["rev-parse", "HEAD"], context.taskDir);
  const branch = String(context.task?.metadata?.branch || "").trim();
  if (!branch) {
    return fallback();
  }

  const worktreeList = gitText(["worktree", "list", "--porcelain"], context.taskDir);
  if (!worktreeList.ok) {
    return fallback();
  }

  const matchedWorktree = findWorktreeForBranch(worktreeList.value, branch);
  if (!matchedWorktree) {
    return fallback();
  }

  const headInWorktree = gitText(["rev-parse", "HEAD"], matchedWorktree);
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

function interpolate(template: any, taskDir: any, artifactFile: any): any {
  const artifactStem = artifactFile ? path.basename(artifactFile, path.extname(artifactFile)) : "";
  return template
    .replace(/\{task-id\}/g, path.basename(taskDir))
    .replace(/\{artifact-stem\}/g, artifactStem);
}
