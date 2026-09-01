// frontmatter, ledger, Git snapshot and platform domains are imported below.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  extractReviewBaseline,
  extractReviewTargetHead,
  extractReviewedHead,
  extractReviewDiffBase,
  extractReviewDiffFingerprint,
  extractReviewedSnapshotTree,
  findAuthoritativeReviewCodeArtifact,
  loadPostReviewConfig,
  parseReviewVerdict,
  resolvePostReviewGlobs
} from "./verification-review.ts";
import { check as checkPlatformSync } from "../platform/verification-sync.ts";
import { check as checkRequiredChecks } from "../platform/verification-required.ts";
import { inspectPlatformPullRequest } from "../platform/pull-requests.ts";
import { resolveMaterializedReviewedHeadRelation } from "../platform/change-request-git-evidence.ts";
import { resolveReviewedHeadRelation } from "../platform/merged-pr-equivalence.ts";
import { resolveLocalReviewedCommitRelation } from "../git/reviewed-commit-equivalence.ts";
import { parseTypedTaskFrontmatter } from "./frontmatter.ts";
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from "./ledger.ts";
import type { LedgerRow } from "./ledger.ts";
import { isValidAgentInfraVersion } from "../version.ts";
import { equalCounts, parseReviewSummary } from "./review-artifacts.ts";
import { inspectDecisionDetailDuplicates } from "./decision-details.ts";
import { loadVerificationConfig } from "./verification-config.ts";
import { snapshotReview } from "../git/review-snapshot.ts";
import { OrchestrationStateError, readRun } from "./orchestration.ts";
import { resolveDeliveryTarget } from "./delivery-target.ts";
import { readPrDeliveryFact } from "./pr-delivery-fact.ts";

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
  "agent_infra_version",
  "current_step",
  "assigned_to"
];

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?$/;
const ACTIVITY_LOG_PATTERN = /^- (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?) — \*\*(.+?)\*\* by (.+?) — (.+)$/;
// Start markers (action suffixed with ` [started]`) are excluded from the
// "latest action" / freshness computation so a step's in-flight marker never
// satisfies a skill's expected_action_pattern; the matching done entry does.
const ACTIVITY_LOG_STARTED_RE = /\s*\[started\]\s*$/;
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Review disagreement ledger (see .agents/rules/review-handshake.md).
const LEDGER_SECTION_NAMES = ["审查分歧账本", "Review Disagreement Ledger"];
const LEDGER_STATUSES = new Set([
  "open",
  "accepted",
  "adjusted",
  "refuted",
  "cannot-judge",
  "confirmed",
  "needs-human-decision",
  "closed",
  "human-decided"
]);
const LEDGER_TERMINAL_OK = new Set(["confirmed", "closed", "human-decided"]);
const DEFAULT_MAX_HANDSHAKE_ROUNDS = 3;
const POST_REVIEW_COMMIT_STAGE = "post-review-commit";
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const WORKFLOW_WARNING_SECTION_NAMES = ["工作流告警", "Workflow Warnings"];
const WORKFLOW_WARNING_STATUSES = new Set(["open", "resolved", "ignored"]);
const WORKFLOW_WARNING_SEVERITIES = new Set(["IMPORTANT", "ACTION_REQUIRED"]);
const WORKFLOW_WARNING_ID_PATTERN = /^WW-\d+$/;

const scriptPath = fileURLToPath(import.meta.url);
let repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

const PLATFORM_ADAPTERS: Record<string, (context: any, shared: any) => any> = {
  "platform-sync": checkPlatformSync,
  "platform-sync-preflight": (context: any, shared: any) => ({ ...checkPlatformSync(context, shared), type: "platform-sync-preflight" }),
  "required-checks": checkRequiredChecks
};
const OPTIONAL_PLATFORM_CHECKS = new Set(["platform-sync"]);

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
  parsePrNumber
};

function runCheck(type: any, context: any, shared: any): any {
  switch (type) {
    case "task-meta":
      return checkTaskMeta(context);
    case "artifact":
      return checkArtifact(context);
    case "decision-details":
      return checkDecisionDetails(context);
    case "implementation-input":
      return checkImplementationInput(context);
    case "activity-log":
      return checkActivityLog(context);
    case "completion-checklist":
      return checkCompletionChecklist(context);
    case "review-ledger":
      return checkReviewLedger(context);
    case "manual-validation":
      return checkManualValidation(context);
    case "review-summary":
      return checkReviewSummary(context);
    case "review-fact":
      return checkReviewFact(context);
    case "post-review-commit":
      return checkPostReviewCommit(context);
    case "required-pr-delivery":
      return checkRequiredPrDelivery(context);
    case "orchestration-state":
      return checkOrchestrationState(context);
    case "orchestration-evidence":
      return checkOrchestrationEvidence(context);
    default: {
      const adapter = PLATFORM_ADAPTERS[type];
      if (!adapter) {
        if (OPTIONAL_PLATFORM_CHECKS.has(type)) {
          return passResult(type, `Skipped: no platform adapter registered for '${type}'`);
        }

        return failResult(type, `Unsupported check type '${type}'.`);
      }

      return adapter(context, shared);
    }
  }
}

function checkOrchestrationState({ taskDir }: any): any {
  const file = path.join(taskDir, 'orchestration.json');
  const stat = safeStat(file);
  if (!stat?.isFile()) return failResult('orchestration-state', 'orchestration.json is missing');
  let run: any;
  try {
    run = readRun(taskDir);
  } catch (error) {
    const message = error instanceof OrchestrationStateError ? error.message : String(error);
    return failResult('orchestration-state', `Invalid orchestration.json: ${message}`);
  }
  if (!run || !['paused', 'completed'].includes(run.status)) {
    return failResult('orchestration-state', `Expected paused or completed run, received '${run?.status ?? 'missing'}'`);
  }
  if (run.status === 'paused' && (!run.pause?.code || !run.pause?.message)) {
    return failResult('orchestration-state', 'Paused run requires a stable pause code and message');
  }
  if (run.status === 'completed') {
    if (run.completionEvidence != null) {
      const evidenceError = validateCleanCompletionEvidence(run);
      if (evidenceError) return failResult('orchestration-state', evidenceError);
    } else if (run.pendingDelegation !== null || !run.commitAuthorization?.consumedAt) {
      return failResult('orchestration-state', 'Completed run must consume commit authorization and clear pending delegation');
    }
  } else if (run.completionEvidence != null) {
    return failResult('orchestration-state', 'Clean completion evidence requires a completed run');
  } else if (run.pendingDelegation?.status === 'sealed') {
    return failResult('orchestration-state', 'Paused run has a sealed delegation that could still advance');
  }
  return passResult('orchestration-state', `Orchestration run is safely ${run.status}`);
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validateCleanCompletionEvidence(run: any): string | null {
  const evidence = run.completionEvidence;
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (
    evidence?.kind !== 'reviewed-head-clean'
    || !exactText(evidence.observedAt)
    || Number.isNaN(Date.parse(evidence.observedAt))
    || !shaPattern.test(evidence.head)
    || !shaPattern.test(evidence.headTree)
    || !shaPattern.test(evidence.worktreeTree)
    || !shaPattern.test(evidence.lastReviewedCommit)
    || !(evidence.prNumber === null || (Number.isInteger(evidence.prNumber) && evidence.prNumber > 0))
    || !(evidence.prHead === null || shaPattern.test(evidence.prHead))
  ) {
    return 'Clean completion evidence has an invalid structure';
  }
  if (
    evidence.head !== evidence.lastReviewedCommit
    || (evidence.prHead !== null && evidence.head !== evidence.prHead)
    || evidence.headTree !== evidence.worktreeTree
  ) {
    return 'Clean completion evidence does not bind matching commit and tree identities';
  }
  if (
    run.status !== 'completed'
    || run.pendingDelegation !== null
    || run.commitAuthorization?.issuedAt !== null
    || run.commitAuthorization?.consumedAt !== null
    || !Array.isArray(run.receipts)
    || run.receipts.some((receipt: any) => receipt.stage === 'commit')
  ) {
    return 'Clean completion evidence conflicts with commit delegation state';
  }
  return null;
}

function checkOrchestrationEvidence({ taskDir }: any): any {
  const file = path.join(taskDir, 'orchestration.json');
  const stat = safeStat(file);
  if (!stat?.isFile()) return failResult('orchestration-evidence', 'orchestration.json is missing');
  let run: any;
  try {
    run = readRun(taskDir);
  } catch (error) {
    const message = error instanceof OrchestrationStateError ? error.message : String(error);
    return failResult('orchestration-evidence', `Invalid orchestration.json: ${message}`);
  }
  const policy = run.modelPolicy;
  if (
    !policy
    || !exactText(policy.executor?.model)
    || !exactText(policy.executor?.reasoningEffort)
    || !exactText(policy.reviewer?.model)
    || !exactText(policy.reviewer?.reasoningEffort)
  ) {
    return failResult('orchestration-evidence', 'Run model policy requires exact executor and reviewer model and effort');
  }
  if (
    !run.modelPolicySource
    || !['explicit', 'project-config'].includes(run.modelPolicySource.kind)
    || !exactText(run.modelPolicySource.client)
    || !exactText(run.modelPolicySource.resolvedAt)
    || !Array.isArray(run.recoveryHistory)
  ) {
    return failResult('orchestration-evidence', 'Run model policy source or recovery history is invalid');
  }
  for (const recovery of run.recoveryHistory) {
    const guards = recovery.guards;
    const validClaudeCodeRecovery = recovery.code === 'CLIENT_CAPABILITY_ENABLED'
      && recovery.previousStatus === 'paused'
      && recovery.previousPause?.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED'
      && recovery.client === 'claude-code'
      && recovery.resultingStatus === 'running'
      && exactText(recovery.recoveredAt)
      && guards?.stepCount === 0
      && guards?.nextStage === null
      && guards?.baselineEmpty === true
      && guards?.receiptCount === 0
      && guards?.pendingDelegation === false
      && guards?.commitAuthorizationUnused === true
      && guards?.completionEvidenceAbsent === true;
    if (!validClaudeCodeRecovery) {
      return failResult('orchestration-evidence', 'Run recovery history contains invalid provenance');
    }
  }
  if (!Array.isArray(run.receipts)) {
    return failResult('orchestration-evidence', 'Run receipts must be an array');
  }
  if (run.completionEvidence != null) {
    const evidenceError = validateCleanCompletionEvidence(run);
    if (evidenceError) return failResult('orchestration-evidence', evidenceError);
  } else if (run.status === 'completed') {
    return failResult('orchestration-evidence', 'Completed run requires reviewed-head-clean completion evidence');
  }
  if (run.pendingDelegation && !['prepared', 'activated', 'stage-completed'].includes(run.pendingDelegation.status)) {
    return failResult('orchestration-evidence', `Pending receipt has unsafe status '${run.pendingDelegation.status}'`);
  }
  const receipts = [...run.receipts, ...(run.pendingDelegation ? [run.pendingDelegation] : [])];
  for (const receipt of receipts) {
    const expectedPolicy = policy[receipt.role];
    if (!expectedPolicy || receipt.requestedModel !== expectedPolicy.model) {
      return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' requested model does not match its role policy`);
    }
    if (receipt.requestedReasoningEffort !== expectedPolicy.reasoningEffort) {
      return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' requested reasoning effort does not match its role policy`);
    }
    const activated = ['activated', 'stage-completed', 'sealed', 'consumed'].includes(receipt.status);
    if (activated) {
      const isClaudeCode = receipt.client === 'claude-code';
      if (!isClaudeCode) {
        if (!exactText(receipt.actualModel)) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has no host-observed actual model`);
        }
        if (!exactText(receipt.actualReasoningEffort)) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has no host-observed actual reasoning effort`);
        }
      }
      // parentId/childId 校验对所有 client 保持统一（不新增分支）；spawnMode 检查按 client 判断
      if (!exactText(receipt.parentId) || !exactText(receipt.childId) || receipt.parentId === receipt.childId) {
        return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has invalid delegation identity`);
      }
      if (!isClaudeCode && receipt.spawnMode !== 'fresh') {
        return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has invalid fresh delegation identity`);
      }
      if (receipt.actualModel != null && receipt.actualModel !== receipt.requestedModel) {
        if (!isClaudeCode && !exactText(receipt.modelFallbackReason)) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' model fallback is not justified`);
        }
      }
      if (
        (receipt.actualModel == null || receipt.actualModel === receipt.requestedModel)
        && receipt.modelFallbackReason !== null
      ) {
        return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has an unrelated model fallback reason`);
      }
      if (receipt.actualReasoningEffort != null && receipt.actualReasoningEffort !== receipt.requestedReasoningEffort) {
        if (!isClaudeCode && !exactText(receipt.reasoningEffortFallbackReason)) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' reasoning-effort fallback is not justified`);
        }
      }
      if (
        (receipt.actualReasoningEffort == null || receipt.actualReasoningEffort === receipt.requestedReasoningEffort)
        && receipt.reasoningEffortFallbackReason !== null
      ) {
        return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has an unrelated reasoning-effort fallback reason`);
      }
      if (receipt.client === 'codex') {
        const activatedCodex = ['activated', 'stage-completed', 'sealed', 'consumed'].includes(receipt.status);
        const host = receipt.hostEvidence;
        const provenance = receipt.lifecycleProvenance;
        if (
          !provenance
          || (activatedCodex && (
            host?.kind !== 'codex-lifecycle-v2'
            || host.protocolVersion !== provenance.protocolVersion
            || host.hookDefinitionHash !== provenance.hookDefinitionHash
            || host.hookSource !== provenance.hookSource
            || host.hookSourcePathDigest !== provenance.hookSourcePathDigest
            || host.hookSourceHash !== provenance.hookSourceHash
            || host.capabilitySessionId !== provenance.capabilitySessionId
            || receipt.parentId !== provenance.capabilitySessionId
            || host.capabilityTurnId !== provenance.capabilityTurnId
            || host.controllerInstanceDigest !== provenance.controllerInstanceDigest
            || host.controlGeneration !== provenance.controlGeneration
            || host.spawnToolUseId === provenance.capabilityToolUseId
            || !exactText(host.spawnToolUseId)
            || !Number.isFinite(Date.parse(host.spawnObservedAt ?? ''))
            || !Number.isFinite(Date.parse(receipt.spawnDispatchedAt ?? ''))
            || !Number.isFinite(Date.parse(receipt.activationDeadlineAt ?? ''))
            || Date.parse(host.spawnObservedAt ?? '') < Date.parse(receipt.spawnDispatchedAt ?? '')
            || Date.parse(host.spawnObservedAt ?? '') > Date.parse(receipt.activationDeadlineAt ?? '')
            || !exactText(host.hookDefinitionHash)
            || !Number.isSafeInteger(host.startRevision)
            || host.startRevision < 1
          ))
        ) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has invalid Codex start evidence`);
        }
        if (['sealed', 'consumed'].includes(receipt.status) && (
          !Number.isSafeInteger(host.stopRevision)
          || host.stopRevision <= host.startRevision
          || host.consumer !== receipt.id
          || !exactText(host.consumedAt)
        )) {
          return failResult('orchestration-evidence', `Receipt '${receipt.id ?? '(unknown)'}' has invalid Codex consumed stop evidence`);
        }
      }
    }
  }
  if (run.receipts.some((receipt: any) => receipt.status !== 'consumed')) {
    return failResult('orchestration-evidence', 'Historical receipts must be consumed');
  }
  return passResult('orchestration-evidence', 'Persisted orchestration model and delegation evidence is internally consistent');
}

// === Check Functions ===

function checkTaskMeta({ taskDir, config }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("task-meta", task.message);
  }

  const metadata = task.metadata;
  const requiredFields = config.required_fields || DEFAULT_REQUIRED_FIELDS;
  const missingFields = requiredFields.filter((field: any) => isBlank(metadata[field]));
  const currentTask = metadata.status === 'active';
  const blockingMissingFields = missingFields.filter((field: any) => field !== "agent_infra_version" || currentTask);
  const warnings = [];
  if (missingFields.includes("agent_infra_version") && !currentTask) {
    warnings.push("field 'agent_infra_version' missing — historical task or skipped version stamp");
  }
  if (blockingMissingFields.length > 0) {
    return failResult("task-meta", `Missing required fields: ${blockingMissingFields.join(", ")}`);
  }

  if (currentTask && !isValidAgentInfraVersion(metadata.agent_infra_version)) {
    return failResult(
      "task-meta",
      `Invalid agent_infra_version: ${String(metadata.agent_infra_version ?? 'missing')}`
    );
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

  const warningValidationErrors = validateWorkflowWarnings(task.content);
  if (warningValidationErrors.length > 0) {
    return failResult("task-meta", `Invalid Workflow Warnings: ${warningValidationErrors.join("; ")}`);
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

  if (config.require_start_date && isBlank(metadata.start_date)) {
    return failResult("task-meta", "Expected start_date to be present");
  }

  if (config.require_target_date && isBlank(metadata.target_date)) {
    return failResult("task-meta", "Expected target_date to be present");
  }

  if (config.match_task_dir !== false) {
    const expectedTaskId = path.basename(taskDir);
    if (metadata.id !== expectedTaskId) {
      return failResult("task-meta", `Task id '${metadata.id}' does not match directory '${expectedTaskId}'`);
    }
  }

  const warningSuffix = warnings.length > 0 ? `; warnings: ${warnings.join("; ")}` : "";
  return passResult(
    "task-meta",
    `Task metadata valid (${requiredFields.length} required fields checked${warningSuffix})`,
    warnings as string[]
  );
}

function checkRequiredPrDelivery({ taskDir, repositoryRoot, mode }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) return failResult('required-pr-delivery', task.message);
  let projectConfig: any = {};
  try {
    const file = path.join(repositoryRoot, '.agents', '.airc.json');
    if (safeStat(file)?.isFile()) projectConfig = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
  } catch {
    return failResult('required-pr-delivery', 'Project configuration is invalid');
  }
  const flow = projectConfig.prFlow;
  const factRead = readPrDeliveryFact(task.metadata);
  if (factRead.status === 'invalid') return failResult('required-pr-delivery', factRead.error.message);
  const fact = factRead.status === 'valid' ? factRead.fact : null;
  const status = fact?.state || 'unbound';
  const prNumber = fact?.state === 'bound' ? fact.identity.number : null;
  if (flow === 'disabled') return passResult('required-pr-delivery', 'Pull request delivery is disabled by project policy');
  if (flow === 'required' && (status !== 'bound' || prNumber === null)) {
    return failResult('required-pr-delivery', 'Project policy requires a bound pull request before completion');
  }
  if (flow !== 'required' && status === 'unbound') {
    return failResult('required-pr-delivery', 'Pull request delivery is pending; create a PR or explicitly skip it');
  }
  if (flow === 'required') {
    if (mode === 'gate') {
      return passResult('required-pr-delivery', 'Bound pull request shape is valid; merged-state inspection is reserved for hard preflight');
    }
    const inspected = inspectPlatformPullRequest(task.metadata.id, { cwd: repositoryRoot });
    if (inspected.status === 'blocked') {
      return blockedResult(
        'required-pr-delivery',
        inspected.error?.message || 'Unable to inspect the required pull request',
        inspected.error?.code || 'PR_INSPECTION_BLOCKED'
      );
    }
    const pullRequest = inspected.pullRequest;
    const repository = inspected.platform.repository?.toLowerCase() || '';
    const taskBranch = String(task.metadata.branch || '').trim();
    const deliveryBaseRef = String(task.metadata.delivery_base_ref || projectConfig.delivery?.baseRef || '').trim();
    if (inspected.status !== 'no-op' || !pullRequest || pullRequest.number !== prNumber) {
      return failResult('required-pr-delivery', 'Bound pull request identity could not be verified');
    }
    if (
      !repository
      || pullRequest.repository.toLowerCase() !== repository
      || pullRequest.base.repository.toLowerCase() !== repository
      || (taskBranch && pullRequest.head.ref !== taskBranch)
      || (deliveryBaseRef && pullRequest.base.ref !== deliveryBaseRef)
    ) {
      return failResult('required-pr-delivery', 'Bound pull request identity does not match the task');
    }
    if (pullRequest.state !== 'closed' || !pullRequest.mergedAt || !pullRequest.mergeCommitSha) {
      return failResult('required-pr-delivery', 'Project policy requires the bound pull request to be merged');
    }
    return passResult('required-pr-delivery', `Pull request delivery policy satisfied (merged PR #${prNumber})`);
  }
  return passResult('required-pr-delivery', `Pull request delivery policy satisfied (${status})`);
}

function validateTaskBranch(metadata: any): any {
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

function loadProjectName(): any {
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

function checkArtifact({ taskDir, config, artifactFile }: any): any {
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
    (section: any) => !new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "m").test(content)
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

  return passResult(
    "artifact",
    `${path.basename(artifactPath)} passed (${requiredSections.length} sections)`
  );
}

function checkDecisionDetails({ taskDir, artifactFile }: any): any {
  const resolvedArtifact = resolveArtifactPath(taskDir, "", artifactFile);
  if (!resolvedArtifact.ok) return failResult("decision-details", resolvedArtifact.message);
  const artifactPath = resolvedArtifact.path;
  const stat = safeStat(artifactPath);
  if (!stat?.isFile()) return failResult("decision-details", `Artifact not found: ${path.basename(artifactPath)}`);
  if (stat.size === 0) return passResult("decision-details", `${path.basename(artifactPath)} contains no decision details`);
  const inspection = inspectDecisionDetailDuplicates(fs.readFileSync(artifactPath, "utf8"));
  if (!inspection.ok) return failResult("decision-details", `${path.basename(artifactPath)}: ${inspection.message}`);
  return passResult("decision-details", `${path.basename(artifactPath)} has no duplicate decision detail ids`);
}

function checkReviewSummary({ taskDir, config, artifactFile }: any): any {
  const stage = String(config.stage || "");
  if (!["analysis", "plan", "code"].includes(stage)) {
    return failResult("review-summary", `Invalid review stage '${stage}'`);
  }
  const resolvedArtifact = resolveArtifactPath(taskDir, "", artifactFile);
  if (!resolvedArtifact.ok || !safeStat(resolvedArtifact.path)?.isFile()) {
    return failResult("review-summary", resolvedArtifact.message || "Review artifact is missing");
  }
  const parsed = parseReviewSummary(fs.readFileSync(resolvedArtifact.path, "utf8"));
  if (!parsed.ok) return failResult("review-summary", `${parsed.code}: ${parsed.message}`);
  if (!parsed.summary.counts) {
    return failResult("review-summary", "Review summary finding counts are not finalized");
  }
  const task = loadTask(taskDir);
  if (!task.ok) return failResult("review-summary", task.message);
  let rows;
  try {
    const ledger = parseLedgerDocument(task.content);
    if (!ledger.present) return failResult("review-summary", `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}`);
    rows = ledger.rows;
  } catch (error) {
    return failResult("review-summary", `Invalid disagreement ledger: ${String(error)}`);
  }
  const invalid = validateLedgerRows(rows);
  if (invalid) return failResult("review-summary", `${invalid.code}: ${invalid.message}`);
  const expected = summarizeLedgerStage(rows, stage as "analysis" | "plan" | "code").unresolvedFindingCounts;
  if (!equalCounts(parsed.summary.counts, expected)) {
    return failResult(
      "review-summary",
      `Review summary counts ${JSON.stringify(parsed.summary.counts)} do not match ledger ${JSON.stringify(expected)}`
    );
  }
  return passResult(
    "review-summary",
    `${path.basename(resolvedArtifact.path)} finding counts match the ${stage} ledger`
  );
}

function checkImplementationInput({ taskDir, artifactFile }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) return failResult("implementation-input", task.message);
  if (!artifactFile) return failResult("implementation-input", "Artifact file is required");
  const artifactPath = path.join(taskDir, artifactFile);
  if (!safeStat(artifactPath)?.isFile()) return failResult("implementation-input", `Artifact not found: ${artifactFile}`);

  const inputSection = getSectionContent(task.content, ["实现输入", "Implementation Inputs"]);
  const rows = [];
  if (inputSection) {
    const table = inputSection.split(/\r?\n/).filter((line: any) => line.trim().startsWith("|"));
    const cells = (line: any) => line.split("|").slice(1, -1).map((cell: any) => cell.trim());
    const expected = ["id", "ledger_id", "decision_evidence", "stage", "needs_implementation", "decided_at", "status", "consumed_by"];
    if (table.length < 2 || JSON.stringify(cells(table[0])) !== JSON.stringify(expected)) {
      return failResult("implementation-input", "Implementation Inputs table schema is invalid");
    }
    const seen = new Set();
    for (const line of table.slice(2)) {
      const row = cells(line);
      if (row.length !== 8 || !/^II-[1-9]\d*$/.test(row[0]) || seen.has(row[0])) {
        return failResult("implementation-input", "Implementation Inputs table contains an invalid or duplicate id");
      }
      seen.add(row[0]);
      rows.push({ id: row[0], ledgerId: row[1], evidence: row[2], stage: row[3], needs: row[4], status: row[6], consumedBy: row[7] });
    }
  }

  const logSection = getSectionContent(task.content, ["活动日志", "Activity Log"]);
  const doneActions = logSection.split(/\r?\n/).flatMap((line: any) => {
    const match = line.trim().match(ACTIVITY_LOG_PATTERN);
    return match && !ACTIVITY_LOG_STARTED_RE.test(match[2]) ? [`${match[2]} — ${match[4]}`] : [];
  });
  const latestAction = doneActions.at(-1) || "";
  const actionDecision =
    /(?:Code Task|Code) \(Round \d+, decision (II-[1-9]\d*)\)/.exec(latestAction)?.[1] ||
    /(?:Code Task|Code) \(Round \d+, fix for review-code(?:-r\d+)?\.md\).*consumed decision (II-[1-9]\d*)/.exec(latestAction)?.[1] ||
    null;
  const report = fs.readFileSync(artifactPath, "utf8");
  const reportSection = getSectionContent(report, ["实现输入", "Implementation Input"]);
  if (!reportSection) return failResult("implementation-input", "Implementation Input report section not found");
  const field = (zh: any, en: any) => {
    const pattern = "^- \\*\\*(?:" + escapeRegExp(zh) + "|" + escapeRegExp(en) + ")\\*\\*[:：]\\s*`?([^`\\n]+)`?\\s*$";
    const match = new RegExp(pattern, "m").exec(reportSection);
    return match?.[1]?.trim() || "";
  };
  const reportInput = field("裁决输入", "Decision Input");
  const reportLedger = field("账本 ID", "Ledger ID");
  const reportEvidence = field("裁决证据", "Decision Evidence");

  if (!actionDecision) {
    if (reportInput && reportInput !== "N/A") {
      return failResult("implementation-input", "Non-decision code action must report Decision Input as N/A");
    }
    return passResult("implementation-input", "Non-decision implementation input identity is consistent");
  }
  if (reportInput !== actionDecision) {
    return failResult("implementation-input", `Report decision input '${reportInput}' does not match Activity Log ${actionDecision}`);
  }
  const matches = rows.filter((row) => row.id === actionDecision);
  if (matches.length !== 1) return failResult("implementation-input", `${actionDecision} is missing or duplicated in task table`);
  const row = matches[0]!;
  if (row.stage !== "code" || row.needs !== "true" || row.status !== "consumed" || row.consumedBy !== artifactFile || !row.evidence) {
    return failResult("implementation-input", `${actionDecision} is not a consumed input for ${artifactFile}`);
  }
  if (reportLedger !== row.ledgerId || reportEvidence !== row.evidence) {
    return failResult("implementation-input", `${actionDecision} report identity does not match task table evidence`);
  }
  return passResult("implementation-input", `${actionDecision} matches Activity Log, report, and task table`);
}

function checkActivityLog({ taskDir, config }: any): any {
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
    .map((line: any) => line.trim())
    .filter((line: any) => line.startsWith("- "));

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
    // Ascending order is checked over every entry, but a `[started]` marker is
    // not a terminal action: keep latestAction/latestTimestamp on the most
    // recent done entry so expected_action_pattern sees it.
    if (!ACTIVITY_LOG_STARTED_RE.test(action)) {
      latestTimestamp = timestamp;
      latestAction = action;
    }
  }

  if (config.expected_action_pattern && !new RegExp(config.expected_action_pattern).test(latestAction)) {
    return failResult(
      "activity-log",
      `Latest action '${latestAction}' does not match '${config.expected_action_pattern}'`
    );
  }

  return passResult("activity-log", `Latest entry '${latestAction}' at ${latestTimestamp}`);
}

function checkCompletionChecklist({ taskDir, config }: any): any {
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
    .map((line: any) => line.trim())
    .filter((line: any) => /^- \[(?: |x|X)\] .+$/.test(line));

  if (items.length === 0) {
    return failResult("completion-checklist", "Completion Checklist has no checkbox items");
  }

  if (config.require_all_checked) {
    const unchecked = items
      .map((line: any) => line.match(/^- \[ \] (.+)$/))
      .filter(Boolean)
      .map((match: any) => match[1].trim());

    if (unchecked.length > 0) {
      return failResult(
        "completion-checklist",
        `Completion Checklist has unchecked items: ${unchecked.join(", ")}`
      );
    }
  }

  return passResult("completion-checklist", `Completion Checklist valid (${items.length} items checked)`);
}

function splitMarkdownTableRow(line: any): any {
  let value = String(line || "").trim();
  if (!value.startsWith("|")) {
    return [];
  }
  value = value.replace(/^\|/, "").replace(/\|$/, "");

  const cells = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "|" && !isEscapedAt(value, index)) {
      cells.push(unescapeMarkdownTableCell(cell.trim()));
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(unescapeMarkdownTableCell(cell.trim()));
  return cells;
}

function unescapeMarkdownTableCell(value: any): any {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === "\\" && (next === "\\" || next === "|")) {
      output += next;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function isEscapedAt(value: any, index: any): any {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function parseWorkflowWarningRows(section: any): any {
  const rows = [];
  for (const rawLine of String(section || "").split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(rawLine);
    if (cells.length === 0) {
      continue;
    }
    if ((cells[0] || "").toLowerCase() === "id") {
      continue;
    }
    if (cells.every((cell: any) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

function validateWorkflowWarnings(content: any): any {
  const section = getSectionContent(content, WORKFLOW_WARNING_SECTION_NAMES);
  if (!section.trim()) {
    return [];
  }

  const rows = parseWorkflowWarningRows(section);
  const errors = [];
  for (const cells of rows) {
    if (cells.length < 11) {
      errors.push(`malformed row (expected 11 columns): ${cells.join(" | ")}`);
      continue;
    }
    const [id, time, step, severity, code, status, target, message, action, resolvedAt, resolution] = cells;
    if (!WORKFLOW_WARNING_ID_PATTERN.test(id)) {
      errors.push(`${id || "(empty id)"}: invalid id`);
    }
    if (!DATE_TIME_PATTERN.test(time)) {
      errors.push(`${id}: invalid time '${time}'`);
    }
    if (isBlank(step)) {
      errors.push(`${id}: step is required`);
    }
    if (!WORKFLOW_WARNING_SEVERITIES.has(severity)) {
      errors.push(`${id}: illegal severity '${severity}'`);
    }
    if (isBlank(code)) {
      errors.push(`${id}: code is required`);
    }
    if (!WORKFLOW_WARNING_STATUSES.has(status)) {
      errors.push(`${id}: illegal status '${status}'`);
    }
    if (isBlank(target)) {
      errors.push(`${id}: target is required`);
    }
    if (isBlank(message)) {
      errors.push(`${id}: message is required`);
    }
    if (status === "open" && isBlank(action)) {
      errors.push(`${id}: open warning requires action`);
    }
    if ((status === "resolved" || status === "ignored") && (isBlank(resolvedAt) || isBlank(resolution))) {
      errors.push(`${id}: ${status} warning requires resolved_at and resolution`);
    }
  }
  return errors;
}

function resolveReviewSetting(config: any, key: any, fallback: any): any {
  if (config && config[key] !== undefined && config[key] !== null) {
    return config[key];
  }
  const reviewConfig = loadPostReviewConfig(repoRoot);
  if (reviewConfig[key] !== undefined && reviewConfig[key] !== null) {
    return reviewConfig[key];
  }
  return fallback;
}

function checkReviewLedger({ taskDir, config }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("review-ledger", task.message);
  }

  let rows;
  try {
    const ledger = parseLedgerDocument(task.content);
    if (!ledger.present) return failResult("review-ledger", `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}`);
    rows = ledger.rows.map((row) => [
      row.id, row.stage, row.round, row.severity, row.status, row.evidence
    ]);
  } catch (error) {
    return failResult("review-ledger", `Invalid disagreement ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rows.length === 0) {
    return passResult("review-ledger", "Disagreement ledger has no entries");
  }

  const stageScope = Array.isArray(config.stage_scope) ? config.stage_scope : null;
  const maxRounds = Number(resolveReviewSetting(config, "maxHandshakeRounds", DEFAULT_MAX_HANDSHAKE_ROUNDS));
  const problems = [];
  let inScopeCount = 0;

  for (const cells of rows) {
    if (cells.length < 6) {
      problems.push(`malformed row (expected 6 columns): ${cells.join(" | ")}`);
      continue;
    }

    const [id, stage, roundRaw, , status, evidence] = cells;
    const stageScoped = stageScope ? stageScope.includes(stage) : true;
    // post-review-commit exemption rows are consumed by the post-review-commit
    // check, not enforced here.
    if (stage === POST_REVIEW_COMMIT_STAGE) {
      continue;
    }
    if (!stageScoped) {
      continue;
    }
    inScopeCount += 1;

    if (!LEDGER_STATUSES.has(status!)) {
      problems.push(`${id}: illegal status '${status}'`);
      continue;
    }
    if (status !== "open" && evidence === "") {
      problems.push(`${id}: status '${status}' requires evidence`);
    }
    const round = Number.parseInt(roundRaw!, 10);
    if (
      Number.isFinite(round) &&
      round >= maxRounds &&
      !LEDGER_TERMINAL_OK.has(status!) &&
      status !== "needs-human-decision"
    ) {
      problems.push(`${id}: round ${round} reached limit ${maxRounds} without convergence; escalate to needs-human-decision`);
    }
    if (!LEDGER_TERMINAL_OK.has(status!)) {
      problems.push(`${id}: unresolved (status '${status}')`);
    }
  }

  if (problems.length > 0) {
    return failResult("review-ledger", `Unclosed/invalid disagreements: ${problems.join("; ")}`);
  }

  const scopeLabel = stageScope ? ` for stages [${stageScope.join(", ")}]` : "";
  return passResult("review-ledger", `Disagreement ledger clean (${inScopeCount} in-scope entries terminal${scopeLabel})`);
}

function checkManualValidation({ taskDir }: any): any {
  // 1. Latest review-code artifact; none -> pass (no review, check not applicable).
  const review = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!review.ok) {
    return passResult("manual-validation", "No review-code artifact; manual validation not applicable");
  }
  // 2. Parse the numeric manual-validation count; unparseable/null -> fail closed
  //    (review-code.completed already enforces a numeric count on the normal path).
  const parsed = parseReviewSummary(fs.readFileSync(review.path!, "utf8"));
  if (!parsed.ok || parsed.summary.manualValidation === null) {
    return failResult("manual-validation", "Latest review-code has no numeric manual-validation count");
  }
  // 3. Count 0 -> pass (no pending items to cover).
  if (parsed.summary.manualValidation === 0) {
    return passResult("manual-validation", "No pending manual validation items");
  }
  // 4. Highest-round manual-validation artifact; none -> fail (items pending,
  //    run complete-manual-validation first). A falsy artifactFile goes through
  //    pattern parsing; resolveArtifactPath only returns { ok, path }.
  const resolved = resolveArtifactPath(taskDir, "manual-validation.md|manual-validation-r{N}.md", "");
  if (!resolved.ok) {
    return failResult(
      "manual-validation",
      `${parsed.summary.manualValidation} manual validation item(s) pending: run /complete-manual-validation`
    );
  }
  // 5. The Activity Log must record the matching completion entry; the file name
  //    is derived with path.basename (resolveArtifactPath does not return fileName).
  const artifactName = path.basename(resolved.path);
  const task = loadTask(taskDir);
  if (!task.ok) return failResult("manual-validation", task.message);
  const log = getSectionContent(task.content, ["活动日志", "Activity Log"]);
  const completed = new RegExp(
    `\\*\\*Complete Manual Validation\\*\\*[\\s\\S]*?Manual validation passed → ${escapeRegExp(artifactName)};`
  );
  if (!completed.test(log)) {
    return failResult(
      "manual-validation",
      `Manual validation artifact exists but completion is not recorded for ${artifactName}: re-run /complete-manual-validation`
    );
  }
  // 6. Timing correlation (PL-3 fix, PL-4 corrected): the completion entry must
  //    sit AFTER the latest review-code round's completion entry in the
  //    append-only Activity Log. indexOf is a literal search, so the artifactName
  //    must NOT be passed through escapeRegExp here (that escapes '.' to '\.',
  //    which indexOf never matches). Not reusing completed.exec().index: exec
  //    anchors to the first '**Complete Manual Validation**' heading, which can
  //    belong to an earlier round's entry and misorder the standard path.
  const reviewDoneIndex = log.indexOf(`**Review Code (Round ${review.round})** by `);
  const completedIndex = log.indexOf(`Manual validation passed → ${artifactName};`);
  if (reviewDoneIndex === -1) {
    // The latest review-code round's completion entry is missing entirely (abnormal
    // state, e.g. a restored/historical task without a review-code.completed record).
    // Re-running complete-manual-validation cannot restore it, so the remediation
    // targets the review record itself. Fail closed either way.
    return failResult(
      "manual-validation",
      `Latest review-code (round ${review.round}) completion entry is missing from the Activity Log (abnormal state): re-run review-code or restore the completion record`
    );
  }
  if (completedIndex < reviewDoneIndex) {
    return failResult(
      "manual-validation",
      `Latest review-code (round ${review.round}) came after the manual validation completion recorded for ${artifactName}: re-run /complete-manual-validation to cover new pending items`
    );
  }
  return passResult("manual-validation", `Manual validation completed → ${artifactName}`);
}

function checkPostReviewCommit({ taskDir, config }: any): any {
  const reviewArtifact = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!reviewArtifact.ok) {
    return passResult("post-review-commit", "No review-code artifact; check inactive");
  }

  let gitRoot;
  try {
    gitRoot = execFileSync("git", ["-C", taskDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return blockedResult("post-review-commit", "git unavailable or task directory is not inside a git repository");
  }

  const task = loadTask(taskDir);
  if (!task.ok) return failResult("post-review-commit", task.message);
  const factRead = readPrDeliveryFact(task.metadata);
  if (factRead.status === 'invalid') return failResult("post-review-commit", factRead.error.message);
  const fact = factRead.status === 'valid' ? factRead.fact : null;
  const lastReviewedCommit = task.ok ? (task.metadata.last_reviewed_commit || "").trim() : "";
  const globs = resolvePostReviewGlobs(config, loadPostReviewConfig(repoRoot));
  const hasPullRequest = fact?.state === 'bound';
  let inspected: ReturnType<typeof inspectPlatformPullRequest> | null = null;
  if (hasPullRequest) {
    inspected = inspectPlatformPullRequest(task.metadata.id, { cwd: gitRoot });
    if (!inspected.pullRequest) {
      const message = inspected.error?.message || "PR merge snapshot is unavailable";
      const code = inspected.error?.code || "PR_INSPECTION_INVALID";
      return inspected.status === "blocked"
        ? blockedResult("post-review-commit", message, code)
        : failResult("post-review-commit", message, code);
    }
    if (
      inspected.pullRequest.state === "closed" &&
      inspected.pullRequest.mergedAt &&
      inspected.pullRequest.mergeCommitSha
    ) {
      const relation = resolveMaterializedReviewedHeadRelation({
        cwd: gitRoot,
        platformType: inspected.platform.type,
        lastReviewedCommit,
        pullRequest: inspected.pullRequest
      });
      if (relation.status === "merged-equivalent") {
        return passResult(
          "post-review-commit",
          `Reviewed PR head is content-equivalent to squash merge ${relation.mergeCommit.slice(0, 8)} on target ${relation.comparisonHead.slice(0, 8)}`
        );
      }
      if (relation.status === "blocked") {
        return blockedResult("post-review-commit", relation.message, relation.code);
      }
      if (relation.status === "strict") {
        return resolvePostReviewIdentityFailure(task.content, {
          code: "PR_MERGE_IDENTITY_INVALID",
          message: "Merged PR evidence did not establish squash merge equivalence"
        });
      }
      if (relation.code === "PR_MERGE_IDENTITY_INVALID") {
        return resolvePostReviewIdentityFailure(task.content, relation);
      }
      return failResult("post-review-commit", relation.message, relation.code);
    }
  }

  const baselineSource = resolvePostReviewBaseline({
    gitRoot,
    lastReviewedCommit,
    reviewArtifact: reviewArtifact.fileName
  });
  if (!baselineSource.ok) {
    return baselineSource.result;
  }

  const sha = baselineSource.sha;
  let commits;
  try {
    const out = execFileSync("git", ["-C", gitRoot, "rev-list", `${sha}..HEAD`, "--", ...globs], { encoding: "utf8" });
    commits = out.split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return blockedResult("post-review-commit", `git rev-list failed for baseline ${sha}; manual inspection required`);
  }

  if (commits.length === 0) {
    return passResult("post-review-commit", `No post-review commits to code/rule paths since ${sha.slice(0, 8)}`);
  }

  let localHead = "";
  try {
    localHead = execFileSync("git", ["-C", gitRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return blockedResult("post-review-commit", "Unable to resolve the local HEAD");
  }

  if (hasPullRequest) {
    if (inspected?.pullRequest) {
      const relation = resolveReviewedHeadRelation({
        gitRoot,
        comparisonHead: localHead,
        lastReviewedCommit: sha,
        pullRequest: inspected.pullRequest
      });
      if (relation.status === "merged-equivalent") {
        return passResult("post-review-commit", `Reviewed PR head is content-equivalent to squash merge ${relation.mergeCommit.slice(0, 8)}`);
      }
      if (relation.status === "blocked") {
        return blockedResult("post-review-commit", relation.message, relation.code);
      }
    }
  } else if (commits.length === 1) {
    const relation = resolveLocalReviewedCommitRelation({
      gitRoot,
      localHead,
      lastReviewedCommit: sha,
      rewrittenCommit: commits[0]!,
      pathspecs: globs
    });
    if (relation.status === "local-equivalent") {
      return passResult(
        "post-review-commit",
        `Reviewed commit is content-equivalent to local rewrite ${relation.rewrittenCommit.slice(0, 8)}`
      );
    }
    if (relation.status === "blocked") {
      return blockedResult("post-review-commit", relation.message);
    }
  }

  const exemption = resolvePostReviewExemption(task.content);
  if (!exemption.ok) return failResult("post-review-commit", exemption.message, exemption.code);
  if (exemption.exemptions.length > 0) {
    return passResult(
      "post-review-commit",
      `${commits.length} post-review commit(s) covered by a human-decided exemption: ${formatPostReviewExemptions(exemption.exemptions)}`
    );
  }

  return failResult(
    "post-review-commit",
    `${commits.length} commit(s) to code/rule paths after reviewed commit ${sha.slice(0, 8)}; re-run review-code or record a human-decided exemption`
  );
}

function resolvePostReviewIdentityFailure(
  content: string,
  failure: { code: string; message: string }
): any {
  const exemption = resolvePostReviewExemption(content);
  if (!exemption.ok) {
    return failResult("post-review-commit", exemption.message, exemption.code);
  }
  if (exemption.exemptions.length === 0) {
    return failResult("post-review-commit", failure.message, failure.code);
  }
  return passResult(
    "post-review-commit",
    `Human-decided post-review exemption overrode ${failure.code}: ${failure.message}; ${formatPostReviewExemptions(exemption.exemptions)}`
  );
}

function formatPostReviewExemptions(exemptions: readonly LedgerRow[]): string {
  return exemptions.map((row) => `${row.id}: ${row.evidence}`).join("; ");
}

function resolvePostReviewExemption(content: string):
  | { ok: true; exemptions: readonly LedgerRow[] }
  | { ok: false; code: "POST_REVIEW_EXEMPTION_INVALID"; message: string } {
  try {
    const ledger = parseLedgerDocument(content);
    if (!ledger.present) {
      return { ok: false, code: "POST_REVIEW_EXEMPTION_INVALID", message: `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}` };
    }
    const rows = ledger.rows;
    const invalid = validateLedgerRows(rows);
    if (invalid) {
      return {
        ok: false,
        code: "POST_REVIEW_EXEMPTION_INVALID",
        message: `${invalid.code}: ${invalid.message}`
      };
    }
    return {
      ok: true,
      exemptions: rows.filter((row) => row.stage === POST_REVIEW_COMMIT_STAGE)
    };
  } catch (error) {
    return {
      ok: false,
      code: "POST_REVIEW_EXEMPTION_INVALID",
      message: `Invalid disagreement ledger: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function checkReviewFact({ taskDir, artifactFile }: any): any {
  const resolvedArtifact = resolveArtifactPath(
    taskDir,
    "review-code.md|review-code-r{N}.md",
    artifactFile
  );
  if (!resolvedArtifact.ok) {
    return failResult("review-fact", resolvedArtifact.message);
  }

  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("review-fact", task.message);
  }

  const content = fs.readFileSync(resolvedArtifact.path, "utf8");
  const verdict = parseReviewVerdict(content);
  const reviewTargetHead = extractReviewTargetHead(content);
  const reviewReviewedHead = extractReviewedHead(content);
  const reviewDiffBase = extractReviewDiffBase(content);
  const reviewedFingerprint = extractReviewDiffFingerprint(content);
  const reviewedTree = extractReviewedSnapshotTree(content);

  if (!["通过", "需要修改", "拒绝", "Approved", "Changes Requested", "Rejected"].includes(verdict)) {
    return failResult("review-fact", `Unsupported review verdict '${verdict}'`);
  }

  const deliveryRemote = String(task.metadata.delivery_remote || "").trim();
  const deliveryBaseRef = String(task.metadata.delivery_base_ref || "").trim();
  if (!deliveryRemote || !deliveryBaseRef) {
    return failResult("review-fact", "Task delivery target is not bound; re-run task branch preparation before review-code");
  }
  if (!reviewTargetHead || !reviewReviewedHead || !reviewDiffBase) {
    return failResult("review-fact", "Review fact must record target head, reviewed head, and diff base");
  }

  let gitRoot;
  let head;
  let baseline;
  let targetHead;
  let diffBase;
  try {
    gitRoot = execFileSync("git", ["-C", taskDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    head = execFileSync("git", ["-C", gitRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const target = resolveDeliveryTarget(gitRoot, { remote: deliveryRemote, baseRef: deliveryBaseRef });
    if (!target.ok) throw new Error(target.message);
    const reviewedRef = reviewReviewedHead;
    baseline = execFileSync("git", ["-C", gitRoot, "rev-parse", `${reviewedRef}^{commit}`], { encoding: "utf8" }).trim();
    targetHead = execFileSync("git", ["-C", gitRoot, "rev-parse", `${reviewTargetHead}^{commit}`], { encoding: "utf8" }).trim();
    const computed = execFileSync("git", ["-C", gitRoot, "merge-base", baseline, targetHead], { encoding: "utf8" }).trim();
    diffBase = execFileSync("git", ["-C", gitRoot, "rev-parse", `${reviewDiffBase}^{commit}`], { encoding: "utf8" }).trim();
    if (diffBase !== computed) throw new Error('saved review diff base does not match merge-base(reviewed head, target head)');
  } catch {
    return blockedResult(
      "review-fact",
      `Unable to resolve saved review commits in the task repository; re-run review-code`
    );
  }

  if (baseline !== head) {
    return failResult(
      "review-fact",
      `Reviewed head ${baseline.slice(0, 8)} does not match current HEAD ${head.slice(0, 8)}; re-run review-code`
    );
  }

  let actualSnapshot;
  try {
    actualSnapshot = snapshotReview({
      cwd: gitRoot,
      mode: "worktree",
      baseline,
      diffBase,
      globs: resolvePostReviewGlobs({}, loadPostReviewConfig(repoRoot))
    });
  } catch {
    return blockedResult(
      "review-fact",
      `Unable to recompute reviewed diff fingerprint from baseline ${baseline.slice(0, 8)}; re-run review-code`
    );
  }

  if (actualSnapshot.fingerprint !== reviewedFingerprint) {
    return failResult(
      "review-fact",
      `Reviewed diff fingerprint does not match the current worktree for baseline ${baseline.slice(0, 8)}; re-run review-code`
    );
  }

  if (!reviewedTree || actualSnapshot.tree !== reviewedTree) {
    return failResult(
      "review-fact",
      `Reviewed snapshot tree does not match the current worktree for baseline ${baseline.slice(0, 8)}; re-run review-code`
    );
  }

  if (["通过", "Approved"].includes(verdict)) {
    const lastReviewedCommit = String(task.metadata.last_reviewed_commit || "").trim();
    const cleanSnapshot = actualSnapshot.tree === execFileSync(
      "git",
      ["-C", gitRoot, "rev-parse", `${baseline}^{tree}`],
      { encoding: "utf8" }
    ).trim();
    if (cleanSnapshot && lastReviewedCommit !== baseline) {
      return failResult(
        "review-fact",
        `Approved clean review must set task last_reviewed_commit to reviewed head ${baseline.slice(0, 8)}`
      );
    }
    if (!cleanSnapshot && lastReviewedCommit) {
      return failResult(
        "review-fact",
        "Approved review with uncommitted changes must remain unanchored until commit"
      );
    }
  }

  return passResult(
    "review-fact",
    `Review fact valid for ${path.basename(resolvedArtifact.path)} at ${baseline.slice(0, 8)}`
  );
}

function resolvePostReviewBaseline({ gitRoot, lastReviewedCommit, reviewArtifact }: any): any {
  if (SHA_PATTERN.test(lastReviewedCommit) && gitCommitExists(gitRoot, lastReviewedCommit)) {
    return { ok: true, sha: lastReviewedCommit };
  }

  return {
    ok: false,
    result: blockedResult(
      "post-review-commit",
      `${reviewArtifact}: reviewed snapshot was not anchored to a valid commit; re-run commit or review-code`
    )
  };
}

function gitCommitExists(gitRoot: any, sha: any): any {
  try {
    execFileSync("git", ["-C", gitRoot, "cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

// === File & Config Loaders ===

function loadTask(taskDir: any): any {
  const taskPath = path.join(taskDir, "task.md");
  if (!fs.existsSync(taskPath)) {
    return { ok: false, message: `Task file not found: ${taskPath}` };
  }

  const content = fs.readFileSync(taskPath, "utf8");
  let metadata;
  try {
    metadata = Object.fromEntries(Object.entries(parseTypedTaskFrontmatter(content)).map(([key, value]) => [key, value === null ? "" : String(value)]));
  } catch {
    return { ok: false, message: "task.md frontmatter not found or invalid" };
  }

  return { ok: true, content, metadata };
}

function resolveArtifactPath(taskDir: any, filePattern: any, artifactFile: any): any {
  if (artifactFile) {
    return { ok: true, path: path.join(taskDir, artifactFile) };
  }

  if (!filePattern) {
    return { ok: false, message: "Artifact file is required for this check" };
  }

  const entries = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
  const matches = [];

  for (const pattern of filePattern.split("|").map((value: any) => value.trim()).filter(Boolean)) {
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
  return { ok: true, path: path.join(taskDir, matches[0]!.fileName) };
}

function getSectionContent(content: any, names: any): any {
  const lines = content.split(/\r?\n/);

  function visibleHeadings(): any {
    const headings = [];
    let fence = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (fence) {
        const closer = line.match(/^ {0,3}(`+|~+)\s*$/);
        if (closer && closer[1][0] === fence.character && closer[1].length >= fence.length) {
          fence = null;
        }
        continue;
      }
      const opener = line.match(/^ {0,3}(`{3,}|~{3,})(?:[^`~].*)?$/);
      if (opener) {
        fence = { character: opener[1][0], length: opener[1].length };
        continue;
      }
      if (line.startsWith("## ")) {
        headings.push({ index, text: line.trim() });
      }
    }
    return headings;
  }

  const headings = visibleHeadings();

  for (const name of names) {
    const heading = `## ${name}`;
    const position = headings.findIndex((item: any) => item.text === heading);
    if (position === -1) {
      continue;
    }
    const startIndex = headings[position]!.index;
    const endIndex = headings[position + 1]?.index ?? lines.length;
    return lines.slice(startIndex + 1, endIndex).join("\n").trim();
  }

  return "";
}

function getCheckedRequirements(content: any): any {
  const section = getSectionContent(content, ["需求", "Requirements"]);
  if (!section) {
    return [];
  }

  return section
    .split(/\r?\n/)
    .map((line: any) => line.trim())
    .map((line: any) => line.match(/^- \[x\] (.+)$/i))
    .filter(Boolean)
    .map((match: any) => match[1].trim());
}

function parseIssueNumber(value: any): any {
  if (isBlank(value) || value === "N/A") {
    return null;
  }

  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function parsePrNumber(value: any): any {
  return parseIssueNumber(value);
}

// === Utilities ===

function normalizeContent(text: any): any {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function interpolate(template: any, taskDir: any, artifactFile: any): any {
  const artifactStem = artifactFile ? path.basename(artifactFile, path.extname(artifactFile)) : "";
  return template
    .replace(/\{task-id\}/g, path.basename(taskDir))
    .replace(/\{artifact-stem\}/g, artifactStem);
}

function summarizeGate(checks: any): any {
  if (checks.some((check: any) => check.status === "blocked")) {
    return "blocked";
  }

  if (checks.some((check: any) => check.status === "fail")) {
    return "fail";
  }

  return "pass";
}

function summarizeChecks(checks: any): any {
  const counts = {
    pass: checks.filter((check: any) => check.status === "pass").length,
    fail: checks.filter((check: any) => check.status === "fail").length,
    blocked: checks.filter((check: any) => check.status === "blocked").length
  };

  if (counts.blocked > 0) {
    return `${counts.pass} passed, ${counts.fail} failed, ${counts.blocked} blocked`;
  }

  return `${counts.pass} passed, ${counts.fail} failed`;
}

function buildAction(gate: any, checks: any): any {
  if (gate === "pass") {
    return "All declared checks passed";
  }

  const firstFailure = checks.find((check: any) => check.status !== "pass");
  if (!firstFailure) {
    return "Review validation output";
  }

  if (gate === "blocked") {
    return `Resolve blocked ${firstFailure.type} check and re-run gate`;
  }

  return `Fix ${firstFailure.type} issues and re-run gate`;
}

function passResult(type: any, message: any, warnings: string[] = []): any {
  const result: { type: any; status: string; message: any; warnings?: string[] } = { type, status: "pass", message };
  if (warnings.length > 0) {
    result.warnings = warnings;
  }
  return result;
}

function failResult(type: any, message: any, failType = "check_failed"): any {
  return { type, status: "fail", fail_type: failType, message };
}

function blockedResult(type: any, message: any, failType = "network_error"): any {
  return { type, status: "blocked", fail_type: failType, message };
}

function safeStat(filePath: any): any {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function escapePattern(pattern: any): any {
  return escapeRegExp(pattern)
    .replace(/\\\{N\\\}/g, "(\\d+)");
}

function escapeRegExp(value: any): any {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBlank(value: any): any {
  return value === undefined || value === null || String(value).trim() === "";
}

function verifyInProcess({ mode, skillName, taskDir, artifactFile, checks: requestedChecks, repositoryRoot }: any): any {
  if (repositoryRoot) repoRoot = path.resolve(repositoryRoot);
  else {
    let cursor = path.resolve(taskDir);
    while (path.dirname(cursor) !== cursor && !fs.existsSync(path.join(cursor, ".agents"))) cursor = path.dirname(cursor);
    if (fs.existsSync(path.join(cursor, ".agents"))) repoRoot = cursor;
  }
  const verifyConfig = loadVerificationConfig(repoRoot, skillName);
  const shared = { ...sharedUtils, repoRoot };
  if (mode === "gate") {
    const checks = [];
    for (const [type, checkConfig] of Object.entries(verifyConfig.checks || {})) {
      if (checkConfig === null) continue;
      const result = runCheck(type, {
        mode,
        skillName,
        taskDir: path.resolve(taskDir),
        artifactFile,
        repositoryRoot: repoRoot,
        config: checkConfig
      }, shared);
      checks.push(result);
      if (result.status === "blocked") break;
    }
    const gate = summarizeGate(checks);
    return { gate, skill: skillName, checks, summary: summarizeChecks(checks), action: buildAction(gate, checks) };
  }
  const type = requestedChecks[0];
  const config = (verifyConfig.checks || {})[type];
  if (config === undefined) return { skill: skillName, ...failResult(type, `Unknown check type '${type}' for skill '${skillName}'.`) };
  if (config === null) return { skill: skillName, ...passResult(type, `Check '${type}' is disabled for skill '${skillName}'.`) };
  return {
    skill: skillName,
    ...runCheck(type, {
      skillName,
      taskDir: path.resolve(taskDir),
      artifactFile,
      repositoryRoot: repoRoot,
      config
    }, shared)
  };
}

export { verifyInProcess };
