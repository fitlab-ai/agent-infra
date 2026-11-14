// frontmatter, ledger, Git snapshot and platform domains are imported below.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  extractReviewTargetHead,
  extractReviewedHead,
  extractReviewDiffBase,
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
import { LEDGER_TERMINAL, LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from "./ledger.ts";
import type { LedgerRow } from "./ledger.ts";
import { isValidAgentInfraVersion } from "../version.ts";
import { equalCounts, parseReviewSummary } from "./review-artifacts.ts";
import { inspectDecisionDetailDuplicates } from "./decision-details.ts";
import { parseImplementationInputs, type ImplementationInput } from "./implementation-inputs.ts";
import { scanVisibleMarkdown } from "./markdown.ts";
import { loadVerificationConfig } from "./verification-config.ts";
import { inspectActivityLog } from "./activity-log.ts";
import { parseWorkflowWarnings } from "./workflow-warnings.ts";
import { readPrDeliveryFact } from "./pr-delivery-fact.ts";
import { validateLocalArtifact } from "./local-artifact-finalization.ts";
import { getArtifactSchema } from "./artifact-schema.ts";
import { inspectArtifactContract } from "./artifact-operations.ts";
import type { VerificationShared } from "./verification-types.ts";
import { normalizeVerificationRecord } from './gate-policy.ts';
import { manualValidationFinalSummaryProjectionMatches } from "./manual-validation-receipt.ts";
import { readManualValidationCompletion } from "./manual-validation-completion.ts";
import { parseArtifactReceipts, receiptForOutput, sha256File } from "./artifact-receipts.ts";
import { inspectArtifactDirectory } from "./artifact-lifecycle.ts";
import { parseArtifactName } from "./artifact-name.ts";
import { summaryCommentState } from "../platform/pr-summary.ts";
import { taskIssueIdentity } from "../platform/task-identities.ts";
import { hasValidArtifactCompletion } from './completion-facts.ts';
import { inspectReviewIdentity } from './review-identity.ts';

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
// Started rows do not represent completed lifecycle actions.
const BRANCH_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Review disagreement ledger (see .agents/rules/review-handshake.md).
const POST_REVIEW_COMMIT_STAGE = "post-review-commit";
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

const PLATFORM_ADAPTERS: Record<string, (context: any, shared: any) => any> = {
  "platform-sync": checkPlatformSync,
  "platform-sync-preflight": async (context: any, shared: any) => ({ ...await checkPlatformSync(context, shared), type: "platform-sync-preflight" }),
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
};

async function runCheck(type: any, context: any, shared: any): Promise<any> {
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
    default: {
      const adapter = PLATFORM_ADAPTERS[type];
      if (!adapter) {
        if (OPTIONAL_PLATFORM_CHECKS.has(type)) {
          return passResult(type, `Skipped: no platform adapter registered for '${type}'`);
        }

        return failResult(type, `Unsupported check type '${type}'.`);
      }

      return await adapter(context, shared);
    }
  }
}

// === Check Functions ===

function validateTaskMetaRequiredFields(metadata: any, requiredFields: any[]): { error: string | null; warnings: string[] } {
  const missingFields = requiredFields.filter((field: any) => isBlank(metadata[field]));
  const currentTask = metadata.status === 'active';
  const blockingMissingFields = missingFields.filter((field: any) => field !== "agent_infra_version" || currentTask);
  const warnings: string[] = [];
  if (missingFields.includes("agent_infra_version") && !currentTask) {
    warnings.push("field 'agent_infra_version' missing — historical task or skipped version stamp");
  }
  if (blockingMissingFields.length > 0) {
    return { error: `Missing required fields: ${blockingMissingFields.join(", ")}`, warnings };
  }
  if (currentTask && !isValidAgentInfraVersion(metadata.agent_infra_version)) {
    return { error: `Invalid agent_infra_version: ${String(metadata.agent_infra_version ?? 'missing')}`, warnings };
  }
  const invalidDates = ["created_at", "updated_at", "completed_at", "blocked_at", "cancelled_at"]
    .filter((field) => !isBlank(metadata[field]) && !DATE_TIME_PATTERN.test(metadata[field]));
  if (invalidDates.length > 0) {
    return { error: `Invalid date format in: ${invalidDates.join(", ")}`, warnings };
  }
  for (const [field, allowedValues] of Object.entries(TASK_ENUMS)) {
    if (!isBlank(metadata[field]) && !allowedValues.includes(metadata[field])) {
      return { error: `Invalid ${field}: ${metadata[field]}`, warnings };
    }
  }
  return { error: null, warnings };
}

function validateTaskMetaBranch(metadata: any, repositoryRoot: string): string | null {
  return validateTaskBranch(metadata, repositoryRoot);
}

function validateTaskMetaExpectations({ taskDir, config, skillName, artifactFile, task, metadata, currentTask }: any): string | null {
  try {
    parseWorkflowWarnings(task.content);
  } catch (error) {
    return `Invalid Workflow Warnings: ${error instanceof Error ? error.message : String(error)}`;
  }

  const expectedStep = config.expected_step;
  if (expectedStep && metadata.current_step !== expectedStep) {
    let validLifecycleArtifact = false;
    if (currentTask) {
      validLifecycleArtifact = checkArtifactLifecycleActivityLog(
        taskDir, artifactFile, skillName, task
      )?.status === "pass";
    }
    if (!validLifecycleArtifact) {
      return `Expected current_step '${expectedStep}', got '${metadata.current_step || "(empty)"}'`;
    }
  }

  const expectedStatus = config.expected_status;
  if (expectedStatus && metadata.status !== expectedStatus) {
    return `Expected status '${expectedStatus}', got '${metadata.status || "(empty)"}'`;
  }

  const requiredMetadata: Array<[string, string, (metadata: any) => boolean]> = [
    ["require_platform_issue_identity", "Expected a valid platform_issue_identity in task metadata", (value) => Boolean(taskIssueIdentity(value))],
    ["require_completed_at", "Expected completed_at to be present", (value) => !isBlank(value.completed_at)],
    ["require_blocked_at", "Expected blocked_at to be present", (value) => !isBlank(value.blocked_at)],
    ["require_cancelled_at", "Expected cancelled_at to be present", (value) => !isBlank(value.cancelled_at)],
    ["require_start_date", "Expected start_date to be present", (value) => !isBlank(value.start_date)],
    ["require_target_date", "Expected target_date to be present", (value) => !isBlank(value.target_date)]
  ];
  for (const [key, message, check] of requiredMetadata) {
    if (config[key] && !check(metadata)) return message;
  }
  return null;
}

function checkTaskMeta({ taskDir, config, repositoryRoot, skillName, artifactFile }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) return failResult("task-meta", task.message);
  const metadata = task.metadata;
  const requiredFields = config.required_fields || DEFAULT_REQUIRED_FIELDS;
  const currentTask = metadata.status === 'active';
  const base = validateTaskMetaRequiredFields(metadata, requiredFields);
  if (base.error) return failResult("task-meta", base.error);
  const contextError = validateTaskMetaBranch(metadata, repositoryRoot);
  if (contextError) return failResult("task-meta", contextError);
  const expectationError = validateTaskMetaExpectations({ taskDir, config, skillName, artifactFile, task, metadata, currentTask });
  if (expectationError) return failResult("task-meta", expectationError);
  if (config.match_task_dir !== false) {
    const expectedTaskId = path.basename(taskDir);
    if (metadata.id !== expectedTaskId) return failResult("task-meta", `Task id '${metadata.id}' does not match directory '${expectedTaskId}'`);
  }

  const warningSuffix = base.warnings.length > 0 ? `; warnings: ${base.warnings.join("; ")}` : "";
  return passResult(
    "task-meta",
    `Task metadata valid (${requiredFields.length} required fields checked${warningSuffix})`,
    base.warnings
  );
}

async function checkRequiredPrDelivery({ taskDir, repositoryRoot, mode }: any): Promise<any> {
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
  const prIdentity = fact?.state === 'bound' ? fact.identity.resource : null;
  const prNumber = prIdentity?.kind === 'number' ? prIdentity.value : null;
  if (flow === 'disabled') return passResult('required-pr-delivery', 'Pull request delivery is disabled by project policy');
  if (flow === 'required' && (status !== 'bound' || !prIdentity)) {
    return failResult('required-pr-delivery', 'Project policy requires a bound pull request before completion');
  }
  if (flow !== 'required' && status === 'unbound') {
    return failResult('required-pr-delivery', 'Pull request delivery is pending; create a PR or explicitly skip it');
  }
  if (flow === 'required') {
    if (mode === 'gate') {
      return passResult('required-pr-delivery', 'Bound pull request shape is valid; merged-state inspection is reserved for hard preflight');
    }
    const inspected = await inspectPlatformPullRequest(task.metadata.id, { cwd: repositoryRoot });
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
    if (inspected.status !== 'no-op' || !pullRequest) {
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
    return passResult('required-pr-delivery', `Pull request delivery policy satisfied (merged PR ${prNumber === null ? 'identity' : `#${prNumber}`})`);
  }
  return passResult('required-pr-delivery', `Pull request delivery policy satisfied (${status})`);
}

function validateTaskBranch(metadata: any, repoRoot: string): any {
  if (isBlank(metadata.branch)) {
    return null;
  }

  const projectName = loadProjectName(repoRoot);
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

function loadProjectName(repoRoot: string): any {
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

const ARTIFACT_SCHEMA_FAMILIES: Readonly<Record<string, string>> = {
  "analyze-task": "analysis",
  "review-analysis": "review-analysis",
  "plan-task": "plan",
  "review-plan": "review-plan",
  "code-task": "code",
  "review-code": "review-code"
};

const LOCAL_ARTIFACT_FAMILIES: Readonly<Record<string, "analysis" | "plan" | "code">> = {
  "analyze-task": "analysis",
  "plan-task": "plan",
  "code-task": "code"
};

function checkArtifactSchema(content: string, artifactPath: string, skillName: string): any | null {
  const schemaFamily = ARTIFACT_SCHEMA_FAMILIES[skillName];
  const schema = schemaFamily ? getArtifactSchema(schemaFamily) : null;
  const localFamily = LOCAL_ARTIFACT_FAMILIES[skillName];
  if (!schema && !localFamily) return null;

  if (schema) {
    const structure = inspectArtifactContract(content, schema);
    if (!structure.ok && !localFamily) {
      return failResult("artifact", `${path.basename(artifactPath)} has shared structural errors: ${structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
    }
  }
  if (localFamily) {
    const local = validateLocalArtifact(content, { family: localFamily });
    if (!local.ok) {
      return failResult(
        "artifact",
        `${path.basename(artifactPath)} has local structural errors: ${local.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`
      );
    }
    return passResult(
      "artifact",
      `${path.basename(artifactPath)} passed (${schema?.sections.length ?? 0} sections)`
    );
  }
  if (schema) {
    return passResult(
      "artifact",
      `${path.basename(artifactPath)} passed (${schema.sections.length} sections)`
    );
  }
  return null;
}

function checkConfiguredArtifact(content: string, artifactPath: string, config: any): any {
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

  const stateCheckPatterns = config.state_check_patterns || [];
  if (stateCheckPatterns.length > 0) {
    const scanned = scanVisibleMarkdown(content);
    const stateCheckHeading = scanned.headings.find((heading) => (
      heading.level === 2 && (heading.text === "状态核对" || heading.text === "State Check")
    ));
    const nextHeading = stateCheckHeading && scanned.headings.find((heading) => (
      heading.start > stateCheckHeading.start && heading.level <= 2
    ));
    const stateCheckBody = stateCheckHeading ? content.slice(stateCheckHeading.end, nextHeading?.start ?? content.length) : "";
    for (const pattern of stateCheckPatterns) {
      if (!new RegExp(pattern, "m").test(stateCheckBody)) {
        return failResult("artifact", `${path.basename(artifactPath)} state-check section is missing required command: ${pattern}`);
      }
    }
  }

  return passResult(
    "artifact",
    `${path.basename(artifactPath)} passed (${requiredSections.length} sections)`
  );
}

function checkArtifact({ taskDir, config, artifactFile, skillName }: any): any {
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
  const schemaResult = checkArtifactSchema(content, artifactPath, skillName);
  if (schemaResult) return schemaResult;
  return checkConfiguredArtifact(content, artifactPath, config);
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

function readImplementationInputReportIdentity(reportSection: string): { input: string; ledger: string; evidence: string } {
  const field = (zh: any, en: any) => {
    const pattern = "^- \\*\\*(?:" + escapeRegExp(zh) + "|" + escapeRegExp(en) + ")\\*\\*[:：]\\s*`?([^`\\n]+)`?\\s*$";
    const match = new RegExp(pattern, "m").exec(reportSection);
    return match?.[1]?.trim() || "";
  };
  return { input: field("裁决输入", "Decision Input"), ledger: field("账本 ID", "Ledger ID"), evidence: field("裁决证据", "Decision Evidence") };
}

function checkImplementationInputIdentity(rows: ImplementationInput[], artifactFile: string, report: { input: string; ledger: string; evidence: string }): any {
  if (!report.input || report.input === "N/A") {
    return passResult("implementation-input", "Non-decision implementation input identity is consistent");
  }
  const matches = rows.filter((row) => row.id === report.input);
  if (matches.length !== 1) return failResult("implementation-input", `${report.input} is missing or duplicated in task table`);
  const row = matches[0]!;
  if (row.stage !== "code" || !row.needsImplementation || row.status !== "consumed" || row.consumedBy !== artifactFile || !row.decisionEvidence) {
    return failResult("implementation-input", `${report.input} is not a consumed input for ${artifactFile}`);
  }
  if (report.ledger !== row.ledgerId || report.evidence !== row.decisionEvidence) {
    return failResult("implementation-input", `${report.input} report identity does not match task table evidence`);
  }
  return passResult("implementation-input", `${report.input} matches report and task table`);
}

function checkImplementationInput({ taskDir, artifactFile }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) return failResult("implementation-input", task.message);
  if (!artifactFile) return failResult("implementation-input", "Artifact file is required");
  const artifactPath = path.join(taskDir, artifactFile);
  if (!safeStat(artifactPath)?.isFile()) return failResult("implementation-input", `Artifact not found: ${artifactFile}`);
  let rows: ImplementationInput[];
  try {
    rows = parseImplementationInputs(task.content).rows;
  } catch (error) {
    return failResult("implementation-input", `Invalid Implementation Inputs: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = fs.readFileSync(artifactPath, "utf8");
  const reportSection = getSectionContent(report, ["实现输入", "Implementation Input"]);
  if (!reportSection) return failResult("implementation-input", "Implementation Input report section not found");
  return checkImplementationInputIdentity(rows, artifactFile, readImplementationInputReportIdentity(reportSection));
}

const ARTIFACT_ACTIVITY_STAGES: Readonly<Record<string, { family: string; event: string }>> = {
  "analyze-task": { family: "analysis", event: "analyze.completed" },
  "plan-task": { family: "plan", event: "plan.completed" },
  "review-analysis": { family: "review-analysis", event: "review-analysis.completed" },
  "review-plan": { family: "review-plan", event: "review-plan.completed" },
  "code-task": { family: "code", event: "code.completed" },
  "review-code": { family: "review-code", event: "review-code.completed" }
};

function resolveCurrentLifecycleArtifact(taskDir: string, artifactFile: string | undefined, skillName: string, stage: { family: string; event: string }): any {
  const inventory = inspectArtifactDirectory(taskDir, stage.family as any);
  if (inventory.status !== "ready" || !inventory.latest) {
    return { error: `Current ${stage.family} artifact is unavailable: ${inventory.error?.message ?? "no artifact exists"}` };
  }
  const output = artifactFile || inventory.latest.name;
  if (output !== inventory.latest.name) {
    return { error: `Artifact '${output}' is not the current ${stage.family} artifact; rerun ${skillName} for '${inventory.latest.name}'` };
  }
  const identity = parseArtifactName(output);
  if (!identity || identity.family !== stage.family) {
    return { error: `Artifact '${output}' does not belong to ${stage.family}` };
  }
  return { output, identity };
}

function validateLifecycleArtifactCompletion(taskDir: string, output: string, skillName: string, stage: { family: string; event: string }, task: any): string | null {
  if (!hasValidArtifactCompletion(task.content, taskDir, output, stage.event)) {
    return `Completion fact for '${output}' is missing or stale; rerun ${skillName} to record a current completion`;
  }
  const receipts = parseArtifactReceipts(task.content).rows.filter((receipt) => receipt.output === output);
  for (const receipt of receipts) {
    const inputIdentity = parseArtifactName(receipt.input);
    if (!inputIdentity) return `Completion receipt for '${output}' has invalid input '${receipt.input}'; rerun ${skillName}`;
    const inputInventory = inspectArtifactDirectory(taskDir, inputIdentity.family as any);
    if (inputInventory.status !== "ready" || inputInventory.latest?.name !== receipt.input
      || sha256File(path.join(taskDir, receipt.input)) !== receipt.inputSha256) {
      return `Input '${receipt.input}' changed or is no longer current; rerun ${skillName} to refresh '${output}'`;
    }
  }
  return null;
}

function checkArtifactLifecycleActivityLog(taskDir: string, artifactFile: string | undefined, skillName: string, task: any): any {
  const stage = ARTIFACT_ACTIVITY_STAGES[skillName];
  if (!stage) return null;
  const current = resolveCurrentLifecycleArtifact(taskDir, artifactFile, skillName, stage);
  if (current.error) return failResult("activity-log", current.error);
  const completionError = validateLifecycleArtifactCompletion(taskDir, current.output, skillName, stage, task);
  if (completionError) return failResult("activity-log", completionError);
  return passResult("activity-log", `Current ${stage.family} completion '${current.output}' is valid for Round ${current.identity.round}`);
}

function checkActivityLog({ taskDir, skillName, artifactFile }: any): any {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("activity-log", task.message);
  }

  const artifactLifecycleResult = checkArtifactLifecycleActivityLog(taskDir, artifactFile, skillName, task);
  if (artifactLifecycleResult && artifactLifecycleResult.status !== "pass") return artifactLifecycleResult;

  const { section, invalidEntries } = inspectActivityLog(task.content);
  const warnings: string[] = [];
  if (!section) warnings.push('Activity Log section is missing or ambiguous');
  else {
    if (invalidEntries.length) warnings.push('Activity Log contains malformed entries');
    if (!section.entries.length) warnings.push('Activity Log has no entries');
    if (section.entries.some((entry) => !entry.note.trim())) warnings.push('Activity Log entry note is empty');
  }
  return passResult("activity-log", artifactLifecycleResult?.message ?? "Business checks are valid", warnings);

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

function reviewLedgerRowIsInScope(stage: string, stageScope: string[] | null): boolean {
  const stageScoped = stageScope ? stageScope.includes(stage) : true;
  return stage !== POST_REVIEW_COMMIT_STAGE && stageScoped;
}

function reviewLedgerRowProblems(row: any): string[] {
  const { id, status, evidence } = row;
  const invalid = validateLedgerRows([row]);
  if (invalid) return [`${invalid.code}: ${invalid.message}`];

  const problems = [];
  if (status !== "open" && evidence === "") {
    problems.push(`${id}: status '${status}' requires evidence`);
  }
  if (!LEDGER_TERMINAL.has(status!)) {
    problems.push(`${id}: unresolved (status '${status}')`);
  }
  return problems;
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
    rows = ledger.rows;
  } catch (error) {
    return failResult("review-ledger", `Invalid disagreement ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rows.length === 0) {
    return passResult("review-ledger", "Disagreement ledger has no entries");
  }

  const stageScope = Array.isArray(config.stage_scope) ? config.stage_scope : null;
  const inScopeRows = rows.filter((row: any) => reviewLedgerRowIsInScope(row.stage, stageScope));
  const problems = inScopeRows.flatMap(reviewLedgerRowProblems);
  if (problems.length > 0) {
    return failResult("review-ledger", `Unclosed/invalid disagreements: ${problems.join("; ")}`);
  }

  const scopeLabel = stageScope ? ` for stages [${stageScope.join(", ")}]` : "";
  return passResult("review-ledger", `Disagreement ledger clean (${inScopeRows.length} in-scope entries terminal${scopeLabel})`);
}

function validateManualValidationReviewTime(task: any, review: any, receipt: any): any | null {
  let reviewReceipt;
  try {
    reviewReceipt = receiptForOutput(task.content, review.fileName!);
  } catch (error) {
    return failResult("manual-validation", `Review-code receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!reviewReceipt || reviewReceipt.event !== "review-code.completed") {
    return failResult("manual-validation", `Review-code completion time is unavailable for ${review.fileName}`);
  }
  const reviewTime = Date.parse(reviewReceipt.completedAt.replace(' ', 'T'));
  const validationTime = Date.parse(receipt.committedAt);
  if (!Number.isFinite(reviewTime) || !Number.isFinite(validationTime) || validationTime <= reviewTime) {
    return failResult("manual-validation", `Manual validation must be completed after review-code ${review.fileName}`);
  }
  return null;
}

function validateManualValidationReceipt(taskDir: string, artifactName: string, review: any): { task: any; receipt: any; error: any | null } {
  const task = loadTask(taskDir);
  if (!task.ok) return { task, receipt: null, error: failResult("manual-validation", task.message) };
  const completion = readManualValidationCompletion(taskDir, { taskId: task.metadata.id, artifact: artifactName });
  if (!completion.ok) {
    const source = completion.error.code.startsWith('MANUAL_VALIDATION_RECEIPT_') ? 'receipt' : 'transaction';
    return { task, receipt: null, error: failResult("manual-validation", `Manual validation ${source} is unavailable: ${completion.error.message}`) };
  }
  const { receipt, transaction } = completion.value;
  if (transaction.phase !== "committed" || !transaction.eventAppended || !transaction.postWriteVerified) {
    return { task, receipt: null, error: failResult("manual-validation", "Manual validation transaction has not reached the committed post-write-verified state") };
  }
  if (transaction.pendingSummaryDigest !== receipt.pendingSummaryDigest || transaction.finalSummaryDigest !== receipt.finalSummaryDigest) {
    return { task, receipt: null, error: failResult("manual-validation", "Manual validation summary digests do not match the committed receipt") };
  }
  if (sha256File(path.join(taskDir, artifactName)) !== receipt.artifactSha256) {
    return { task, receipt: null, error: failResult("manual-validation", `Manual validation artifact digest does not match the receipt for ${artifactName}`) };
  }
  const timeError = validateManualValidationReviewTime(task, review, receipt);
  if (timeError) return { task, receipt: null, error: timeError };
  return { task, receipt, error: null };
}

async function checkBoundManualValidationPullRequest(task: any, repositoryRoot: string, receipt: any): Promise<any | null> {
  const fact = readPrDeliveryFact(task.metadata);
  if (fact.status === "invalid") return failResult("manual-validation", fact.error.message);
  if (fact.status !== "valid" || fact.fact.state !== "bound") return null;
  const inspected = await inspectPlatformPullRequest(task.metadata.id, { cwd: repositoryRoot });
  if (!inspected.pullRequest) return failResult("manual-validation", inspected.error?.message ?? "canonical pull-request head is unavailable");
  if (inspected.pullRequest.head.sha !== receipt.prHeadSha) return failResult("manual-validation", "manual validation receipt is stale for the current pull-request head");
  const summary = await summaryCommentState(task.metadata.id, { cwd: repositoryRoot });
  if (!summary.comment) return failResult("manual-validation", "canonical pull-request summary comment is unavailable");
  if (!manualValidationFinalSummaryProjectionMatches(summary.comment.body, receipt)) return failResult("manual-validation", "canonical pull-request summary does not match the committed manual validation projection");
  return null;
}

async function checkManualValidation({ taskDir, repositoryRoot }: any): Promise<any> {
  // 1. Latest review-code artifact; none -> pass (no review, check not applicable).
  const review = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!review.ok) {
    if (review.error) return failResult("manual-validation", `Review-code artifact is unavailable: ${review.error}`);
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
  // 5. Validate the committed receipt, transaction, and artifact.
  const artifactName = path.basename(resolved.path);
  const validated = validateManualValidationReceipt(taskDir, artifactName, review);
  if (validated.error) return validated.error;
  const pullRequestError = await checkBoundManualValidationPullRequest(validated.task, repositoryRoot, validated.receipt);
  if (pullRequestError) return pullRequestError;
  return passResult("manual-validation", `Manual validation completed → ${artifactName} (committed receipt and post-write verification)`);
}

async function checkPostReviewCommit({ taskDir, config, repositoryRoot }: any): Promise<any> {
  const reviewArtifact = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!reviewArtifact.ok) {
    if (reviewArtifact.error) return failResult("post-review-commit", `Review-code artifact is unavailable: ${reviewArtifact.error}`);
    return passResult("post-review-commit", "No review-code artifact; check inactive");
  }

  let gitRoot;
  try {
    gitRoot = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return blockedResult("post-review-commit", "git unavailable or repository root is not inside a git repository");
  }

  const task = loadTask(taskDir);
  if (!task.ok) return failResult("post-review-commit", task.message);
  const factRead = readPrDeliveryFact(task.metadata);
  if (factRead.status === 'invalid') return failResult("post-review-commit", factRead.error.message);
  const fact = factRead.status === 'valid' ? factRead.fact : null;
  const lastReviewedCommit = task.ok ? (task.metadata.last_reviewed_commit || "").trim() : "";
  const globs = resolvePostReviewGlobs(config, loadPostReviewConfig(repositoryRoot));
  const hasPullRequest = fact?.state === 'bound';
  let inspected: Awaited<ReturnType<typeof inspectPlatformPullRequest>> | null = null;
  if (hasPullRequest) {
    inspected = await inspectPlatformPullRequest(task.metadata.id, { cwd: gitRoot });
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
      const relation = await resolveMaterializedReviewedHeadRelation({
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

  let localHead: string;
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

function checkReviewFact({ taskDir, artifactFile, repositoryRoot }: any): any {
  const artifact = resolveReviewFactArtifact(taskDir, artifactFile);
  if (!artifact.ok) {
    return artifact.result;
  }

  const task = loadTask(taskDir);
  if (!task.ok) {
    return failResult("review-fact", task.message);
  }

  const content = fs.readFileSync(artifact.path, "utf8");
  if (!hasValidArtifactCompletion(task.content, taskDir, path.basename(artifact.path), 'review-code.completed')) {
    return failResult("review-fact", `Review Code completion fact does not match ${path.basename(artifact.path)}`);
  }

  const verdict = parseReviewVerdict(content);
  const reviewTargetHead = extractReviewTargetHead(content);
  const reviewReviewedHead = extractReviewedHead(content);
  const reviewDiffBase = extractReviewDiffBase(content);

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

  const identity = validateReviewFactIdentity(taskDir, content, repositoryRoot, task, verdict);
  if (!identity.ok) {
    return identity.result;
  }

  return passResult(
    "review-fact",
    `Review fact valid for ${path.basename(artifact.path)} at ${identity.reviewedHead.slice(0, 8)}`
  );
}

function resolveReviewFactArtifact(taskDir: any, artifactFile: any): any {
  const resolvedArtifact = resolveArtifactPath(
    taskDir,
    "review-code.md|review-code-r{N}.md",
    artifactFile
  );
  if (!resolvedArtifact.ok) {
    return { ok: false, result: failResult("review-fact", resolvedArtifact.message) };
  }

  const authoritative = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!authoritative.ok) {
    return {
      ok: false,
      result: failResult("review-fact", authoritative.error ?? "No active review-code artifact is available")
    };
  }
  if (path.basename(resolvedArtifact.path) !== authoritative.fileName) {
    return {
      ok: false,
      result: failResult(
        "review-fact",
        `review-code artifact ${path.basename(resolvedArtifact.path)} is not the current active artifact ${authoritative.fileName}; re-run review-code`
      )
    };
  }

  return { ok: true, path: resolvedArtifact.path };
}

function validateReviewFactIdentity(taskDir: any, content: string, repositoryRoot: any, task: any, verdict: any): any {
  const identity = inspectReviewIdentity(taskDir, content, repositoryRoot);
  if (identity.status !== 'matched' || !identity.reviewedHead) {
    return {
      ok: false,
      result: failResult('review-fact', `Review identity is ${identity.status}: ${identity.message}; re-run review-code`)
    };
  }

  const baseline = identity.reviewedHead;
  if (["通过", "Approved"].includes(verdict)) {
    const lastReviewedCommit = String(task.metadata.last_reviewed_commit || "").trim();
    if (lastReviewedCommit !== baseline) {
      return {
        ok: false,
        result: failResult(
          "review-fact",
          `Approved clean review must set task last_reviewed_commit to reviewed head ${baseline.slice(0, 8)}`
        )
      };
    }
  }

  return { ok: true, reviewedHead: baseline };
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

function getSectionContent(content: string, names: readonly string[]): string {
  const headings = scanVisibleMarkdown(content).headings.filter((heading) => heading.level === 2);
  for (const name of names) {
    const position = headings.findIndex((heading) => heading.text === name);
    if (position === -1) continue;
    return content.slice(headings[position]!.end + 1, headings[position + 1]?.start ?? content.length).replace(/\r\n/g, "\n").trim();
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

// === Utilities ===

function normalizeContent(text: any): any {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeGate(checks: any): any {
  if (checks.some((check: any) => check.effectiveStatus === "blocked")) {
    return "blocked";
  }

  if (checks.some((check: any) => check.effectiveStatus === "fail")) {
    return "fail";
  }

  return "pass";
}

function summarizeChecks(checks: any): any {
  const counts = {
    pass: checks.filter((check: any) => check.effectiveStatus === "pass").length,
    fail: checks.filter((check: any) => check.effectiveStatus === "fail").length,
    blocked: checks.filter((check: any) => check.effectiveStatus === "blocked").length
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

  const firstFailure = checks.find((check: any) => check.effectiveStatus !== "pass");
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

async function verifyInProcess({ mode, skillName, taskDir, artifactFile, checks: requestedChecks, repositoryRoot }: any): Promise<any> {
  let repoRoot = repositoryRoot ? path.resolve(repositoryRoot) : defaultRepoRoot;
  if (!repositoryRoot) {
    let cursor = path.resolve(taskDir);
    while (path.dirname(cursor) !== cursor && !fs.existsSync(path.join(cursor, ".agents"))) cursor = path.dirname(cursor);
    if (fs.existsSync(path.join(cursor, ".agents"))) repoRoot = cursor;
  }
  const verifyConfig = loadVerificationConfig(repoRoot, skillName);
  const shared: VerificationShared = { ...sharedUtils, repoRoot };
  if (mode === "gate") {
    const checks = [];
    for (const [type, checkConfig] of Object.entries(verifyConfig.checks || {})) {
      if (checkConfig === null) continue;
      const result = normalizeVerificationRecord(await runCheck(type, {
        mode,
        skillName,
        taskDir: path.resolve(taskDir),
        artifactFile,
        repositoryRoot: repoRoot,
        config: checkConfig
      }, shared));
      checks.push(...(result.subchecks?.map(normalizeVerificationRecord) ?? [result]));
      if (checks.at(-1)?.effectiveStatus === "blocked") break;
    }
    const gate = summarizeGate(checks);
    return { gate, skill: skillName, checks, summary: summarizeChecks(checks), action: buildAction(gate, checks) };
  }
  const type = requestedChecks[0];
  const config = (verifyConfig.checks || {})[type];
  if (config === undefined) return { skill: skillName, ...failResult(type, `Unknown check type '${type}' for skill '${skillName}'.`) };
  if (config === null) return { skill: skillName, ...passResult(type, `Check '${type}' is disabled for skill '${skillName}'.`) };
  const result = normalizeVerificationRecord(await runCheck(type, {
      skillName,
      taskDir: path.resolve(taskDir),
      artifactFile,
      repositoryRoot: repoRoot,
      config
    }, shared));
  if (!result.subchecks?.length) return { skill: skillName, ...result };
  const checks = result.subchecks.map(normalizeVerificationRecord);
  const gate = summarizeGate(checks);
  return {
    skill: skillName,
    ...result,
    status: gate,
    effectiveStatus: gate,
    reason: gate === 'pass' ? 'OK' : checks.find((check: any) => check.effectiveStatus !== 'pass')?.reason ?? 'CHECK_FAILED',
    action: buildAction(gate, checks),
    checks
  };
}

export { verifyInProcess };
