import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { enumerateArtifacts } from '../task/artifacts.ts';
import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import type { ResolveRefResult } from '../task/resolve-ref.ts';
import { readPrDeliveryFact } from '../task/pr-delivery-fact.ts';
import type { PrDeliveryFact } from '../task/pr-delivery-fact.ts';
import { resolvePlatformProviderContext } from './context.ts';
import { inspectPlatformPullRequest } from './pull-requests.ts';
import type { LoadedContext, PlatformClient } from './context.ts';
import { normalizeCommentContent } from './issue-comments.ts';
import { CONTROL_MARKER_PATTERN, sanitizeMarkdownDocument, splitDocumentPlaceholder } from './comment-safety.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import { coordinateManagedSummary } from './operation-coordinator.ts';
import type { ManagedSummaryPolicy, ManagedSummaryPrepared } from './managed-summary-core.ts';
import { executeManagedSummary, previewManagedSummary } from './managed-summary-core.ts';
import type { PlatformOperation as JournalOperation } from '../task/platform-operation-journal.ts';
import type { OperationWarning } from '../task/operation-outcome.ts';
import { providerError, providerOperationContext, providerStatus, providerResourceToken, resourceIdentityNumber, unsupportedProviderOperation } from './provider-bridge.ts';
import { resourceIdentityEquals } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';
import type { PlatformChangeRequestSnapshot } from './snapshots.ts';
import type { ChangeRequestSnapshot } from './provider-contract.ts';
import {
  buildPrChangeReport,
  CANONICAL_REPORT_PLACEHOLDER,
  readPrChangeReport,
  replaceCanonicalReportPlaceholder,
  runMechanicalChangeReport,
  taskIntentDigest,
  validateMechanicalReport,
  validatePrecheckCandidate,
  writePrChangeReportAtomic
} from './pr-change-report.ts';
import type {
  MechanicalChangeReport,
  PrChangeReport
} from './pr-change-report.ts';
import { MANUAL_VALIDATION_RECEIPT_PLACEHOLDER, manualValidationFinalSummaryProjectionMatches } from '../task/manual-validation-receipt.ts';
import { readManualValidationCompletion } from '../task/manual-validation-completion.ts';
import { readManualValidationTransaction } from '../task/manual-validation-transaction.ts';
import { parsePrSummaryContent, renderPrSummaryContent } from './pr-summary-content.ts';
import { runSummaryContentPipeline } from './summary-content-pipeline.ts';
import { parseLedgerDocument } from '../task/ledger.ts';

type SummaryComment = { id: number | string; body: string };
type ChangeReportState = 'ready' | 'missing' | 'stale' | 'invalid';
type SummaryContextResult = PlatformResult & {
  task: { id: string | null; prNumber: number | null };
  pullRequest: PlatformChangeRequestSnapshot | null;
  changeReport: { status: ChangeReportState; path: string; taskIntentSha256: string | null; reason?: string };
  artifacts: Array<{ family: string; name: string; path: string }>;
};
type PullRequestSummaryResult = PlatformResult & {
  result: 'pr_created_with_warnings' | 'pr_reused_with_warnings' | 'no_op_with_warnings' | null;
  warnings: readonly OperationWarning[];
  precheckVerdict?: 'clear' | 'needs-review';
  nextAction?: 'watch-pr' | 'review-code';
};
type PullRequestPrimaryResult = 'pr_created' | 'pr_reused' | 'no_op';
type SummaryOptions = { cwd?: string; client?: PlatformClient; runtimeVersion?: string };
type ManualValidationSummaryOptions = {
  phase: 'pending' | 'final';
  transactionId?: string;
  receiptDigest?: string;
  prHeadSha?: string;
  authority?: 'coordinator';
};
type PullRequestSummarySyncOptions = {
  agent: string;
  body: string;
  changeReportFile?: string;
  cwd?: string;
  client?: PlatformClient;
  dryRun?: boolean;
  strict?: boolean;
  primaryResult: PullRequestPrimaryResult;
  runtimeVersion?: string;
  manualValidation?: ManualValidationSummaryOptions;
  skipQueue?: boolean;
  queuedOperation?: JournalOperation;
};
type ResolvedTaskRef = Extract<ResolveRefResult, { ok: true }>;
type ReportWriteResult = PlatformResult & {
  report: { path: string; status: 'written' | 'no-op' | 'planned'; precheckVerdict: 'clear' | 'needs-review'; nextAction: 'watch-pr' | 'review-code' } | null;
};
type SummaryCommentStateResult = Omit<PlatformResult, 'comment'> & {
  task: { id: string | null; prNumber: number | null };
  pullRequest: PlatformChangeRequestSnapshot | null;
  comment: SummaryComment | null;
};

function summaryMarker(taskId: string): string {
  return `<!-- sync-pr:${taskId}:summary -->`;
}

function isSafeSummaryEnvelope(value: string, taskId: string): boolean {
  return value.includes(summaryMarker(taskId))
    && (value.match(/<!--\s*sync-pr:/gi) || []).length === 1
    && (value.match(/<!--\s*last-commit:/gi) || []).length === 1
    && !/<!--\s*canonical-pr-change-report\b/i.test(value);
}

function taskReportPath(taskDir: string): string {
  return path.join(taskDir, 'pr-change-report.json');
}

function readBoundTaskSnapshot(taskMdPath: string): {
  taskContent: string;
  boundFact: Extract<PrDeliveryFact, { state: 'bound' }> | null;
  factError: { code: string; message: string } | null;
} {
  const taskContent = fs.readFileSync(taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(taskContent);
  const fact = readPrDeliveryFact(frontmatter);
  const boundFact = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact : null;
  const factError = fact.status === 'invalid' ? { code: fact.error.code, message: fact.error.message } : null;
  return { taskContent, boundFact, factError };
}

function boundPrNumberForWarning(taskMdPath: string): number | null {
  try {
    const { boundFact } = readBoundTaskSnapshot(taskMdPath);
    return boundFact ? resourceIdentityNumber(boundFact.identity.resource) : null;
  } catch {
    return null;
  }
}

function warningResultForPrimary(primaryResult: PullRequestPrimaryResult): NonNullable<PullRequestSummaryResult['result']> {
  if (primaryResult === 'pr_created') return 'pr_created_with_warnings';
  if (primaryResult === 'pr_reused') return 'pr_reused_with_warnings';
  return 'no_op_with_warnings';
}

function platformError(error: { code: string; message: string; retryable?: boolean }): NonNullable<PlatformResult['error']> {
  return { code: error.code, message: error.message, retryable: error.retryable ?? false };
}

function buildPullRequestSummary(taskId: string, body: string, headSha: string): string {
  return normalizeCommentContent(`${summaryMarker(taskId)}\n<!-- last-commit: ${headSha} -->\n\n${body.replace(/\s+$/, '')}\n`);
}

function canonicalArtifacts(taskDir: string) {
  const allowed = /^(plan|review-plan|code|review-code|manual-validation)(?:-r\d+)?\.md$/;
  const byFamily = new Map<string, { family: string; name: string; path: string; round: number }>();
  for (const artifact of enumerateArtifacts(taskDir)) {
    if (!allowed.test(artifact.name)) continue;
    const match = artifact.name.match(/^(plan|review-plan|code|review-code|manual-validation)(?:-r(\d+))?\.md$/)!;
    const family = match[1]!;
    const round = match[2] ? Number(match[2]) : 1;
    const current = byFamily.get(family);
    if (!current || round > current.round) byFamily.set(family, { family, name: artifact.name, path: artifact.path, round });
  }
  return [...byFamily.values()].map(({ family, name, path: artifactPath }) => ({ family, name, path: artifactPath }));
}

function basePlatformResult(
  status: PlatformResult['status'],
  context: PlatformResult,
  taskId: string | null,
  prNumber: number | null,
  error: PlatformResult['error'] = null
): PlatformResult {
  return platformResult(status, {
    platform: context.platform,
    capabilities: context.capabilities,
    operations: context.operations,
    resource: { kind: 'pull-request', number: prNumber },
    error,
    ...(taskId ? { task: { id: taskId, prNumber } } : {})
  });
}

function isHardSummaryFailure(error: PlatformResult['error']): boolean {
  return error?.code === 'PR_SUMMARY_HEAD_RACE'
    || error?.code === 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED'
    || error?.code === 'PR_SUMMARY_RACE_COMPENSATION_FAILED'
    || Boolean(error?.code.startsWith('MANAGED_SUMMARY_'));
}

function inspectionError(error: { code: string; message: string; retryable: boolean }): PlatformResult['status'] {
  return error.retryable ? 'blocked' : 'failed';
}

function preparationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function validateManualSummaryPhase(manual: ManualValidationSummaryOptions | undefined, rendered: string): void {
  const hasFinal = /###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)/u.test(rendered);
  if (hasFinal && (!manual || manual.phase !== 'final')) throw preparationError('MANUAL_VALIDATION_TRANSACTION_REQUIRED', 'final manual-validation summary requires the transaction coordinator');
  if (manual && (manual.phase === 'pending' ? hasFinal : !hasFinal)) throw preparationError('MANUAL_VALIDATION_SUMMARY_PHASE_INVALID', 'manual-validation summary phase does not match the requested writer phase');
}

function readPendingManualEvidence(resolved: ResolvedTaskRef, manual: ManualValidationSummaryOptions, current: PlatformChangeRequestSnapshot, prNumber: number): null {
  const transaction = readManualValidationTransaction(resolved.taskDir, { transactionId: manual.transactionId!, taskId: resolved.taskId, prNumber, prHeadSha: current.head.sha });
  if (!transaction.ok) throw preparationError(transaction.error.code, transaction.error.message);
  return null;
}

function readFinalManualEvidence(resolved: ResolvedTaskRef, manual: ManualValidationSummaryOptions, rendered: string, current: PlatformChangeRequestSnapshot, prNumber: number): string {
  if (!manual.receiptDigest || manual.prHeadSha !== current.head.sha || manual.authority !== 'coordinator') throw preparationError('MANUAL_VALIDATION_TRANSACTION_REQUIRED', 'final manual-validation summary requires transaction, receipt, and current head identity');
  const completion = readManualValidationCompletion(resolved.taskDir, { transactionId: manual.transactionId!, taskId: resolved.taskId, prNumber, prHeadSha: current.head.sha, receiptDigest: manual.receiptDigest });
  if (!completion.ok) throw preparationError(completion.error.code, completion.error.message);
  if (completion.value.transaction.phase !== 'final-promotion-in-progress' || !completion.value.transaction.eventAppended
    || !manualValidationFinalSummaryProjectionMatches(rendered, completion.value.receipt)) throw preparationError('MANUAL_VALIDATION_SUMMARY_PROJECTION_INVALID', 'final summary does not match the receipt-backed promotion intent');
  return completion.value.receipt.evidenceDigest;
}

async function manualValidationEvidence(
  resolved: ResolvedTaskRef,
  manual: ManualValidationSummaryOptions | undefined,
  rendered: string,
  current: PlatformChangeRequestSnapshot
): Promise<string | null> {
  validateManualSummaryPhase(manual, rendered);
  if (!manual) return null;
  const prNumber = current.number;
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw preparationError('MANUAL_VALIDATION_PR_NUMBER_REQUIRED', 'manual-validation summary requires a positive safe pull-request number from the authoritative snapshot');
  if (!manual.transactionId) throw preparationError('MANUAL_VALIDATION_TRANSACTION_REQUIRED', 'manual-validation summary requires a transaction ID');
  return manual.phase === 'pending'
    ? readPendingManualEvidence(resolved, manual, current, prNumber!)
    : readFinalManualEvidence(resolved, manual, rendered, current, prNumber!);
}

function validatedSummaryReport(
  resolved: ResolvedTaskRef,
  options: PullRequestSummarySyncOptions,
  current: PlatformChangeRequestSnapshot,
  taskContent: string
): PrChangeReport {
  if (!options.changeReportFile) throw preparationError('PR_CHANGE_REPORT_MISSING', 'summary-sync requires --change-report-file');
  const reportPath = taskReportPath(resolved.taskDir);
  if (path.resolve(resolved.repoRoot, options.changeReportFile) !== reportPath) throw preparationError('PR_CHANGE_REPORT_PATH_INVALID', 'summary-sync must consume the task-bound pr-change-report.json');
  const report = readPrChangeReport(reportPath);
  if (!report.ok) throw preparationError(report.error.code, report.error.message);
  const checked = currentReportCheck(report.value, current, taskContent, resolved.repoRoot);
  if (!checked.ok) throw preparationError(checked.error.code, checked.error.message);
  return report.value;
}

function renderedSummaryBody(taskId: string, rendered: string, report: PrChangeReport, manual: ManualValidationSummaryOptions | undefined, evidenceDigest: string | null, headSha: string): string {
  const split = splitDocumentPlaceholder(rendered, CANONICAL_REPORT_PLACEHOLDER);
  if (!split.ok) throw preparationError('PR_SUMMARY_BODY_CONTRACT_INVALID', split.error.message);
  const prefix = sanitizeMarkdownDocument(split.value.prefix, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  const suffix = sanitizeMarkdownDocument(split.value.suffix, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  if (!prefix.ok || !suffix.ok) throw preparationError('PR_SUMMARY_BODY_CONTRACT_INVALID', 'PR summary body contract is invalid');
  const replaced = replaceCanonicalReportPlaceholder(`${prefix.value}${CANONICAL_REPORT_PLACEHOLDER}${suffix.value}`, report);
  if (!replaced.ok) throw preparationError(replaced.error.code, replaced.error.message);
  const withReceipt = manual?.phase === 'final' ? replaced.value.replace(MANUAL_VALIDATION_RECEIPT_PLACEHOLDER,
    `<!-- manual-validation-receipt: transaction=${manual.transactionId}; receipt=${manual.receiptDigest}; evidence=${evidenceDigest}; head=${manual.prHeadSha} -->`) : replaced.value;
  const body = buildPullRequestSummary(taskId, withReceipt, headSha);
  if (!isSafeSummaryEnvelope(body, taskId)) throw preparationError('PR_SUMMARY_RENDER_INVALID', 'Summary contains an invalid or duplicated reserved control marker');
  return body;
}

type PreparedBoundSummary = Readonly<{
  summary: ManagedSummaryPrepared;
  prNumber: number;
  precheckVerdict: 'clear' | 'needs-review';
  nextAction: 'watch-pr' | 'review-code';
}>;

function prepareBoundSummaryContent(body: string, taskContent: string) {
  try { return prepareAndRenderPrSummaryContent(JSON.parse(body), taskContent); }
  catch (error) {
    throw preparationError('PR_SUMMARY_CONTENT_INVALID', error instanceof Error ? error.message : String(error));
  }
}

async function prepareBoundPullRequestSummary(
  resolved: ResolvedTaskRef,
  options: PullRequestSummarySyncOptions,
  context: PlatformResult,
  loaded: LoadedContext,
  expectedIdentity: ResourceIdentity
): Promise<PreparedBoundSummary> {
  const snapshot = readBoundTaskSnapshot(resolved.taskMdPath);
  if (snapshot.factError) throw preparationError(snapshot.factError.code, snapshot.factError.message);
  if (!snapshot.boundFact || !resourceIdentityEquals(snapshot.boundFact.identity.resource, expectedIdentity)) throw preparationError('PLATFORM_OPERATION_IDENTITY_MISMATCH', 'Bound pull request identity changed while the summary was queued');
  const preparedContent = prepareBoundSummaryContent(options.body, snapshot.taskContent);
  const current = await inspectBoundPullRequest(context, resolved.repoRoot, expectedIdentity, loaded);
  if (!current.ok) throw preparationError(current.error?.code || 'PR_SNAPSHOT_UNAVAILABLE', current.error?.message || 'Pull-request snapshot is unavailable');
  const evidenceDigest = await manualValidationEvidence(resolved, options.manualValidation, preparedContent.rendered, current.value);
  const report = validatedSummaryReport(resolved, options, current.value, snapshot.taskContent);
  const body = renderedSummaryBody(resolved.taskId, preparedContent.rendered, report, options.manualValidation, evidenceDigest, current.value.head.sha);
  return {
    summary: {
      parent: expectedIdentity, marker: summaryMarker(resolved.taskId), body, position: 'none',
      fence: { headSha: current.value.head.sha, ...(options.manualValidation?.transactionId ? { manualValidation: { ...options.manualValidation, transactionId: options.manualValidation.transactionId } } : {}) }
    },
    prNumber: current.value.number,
    precheckVerdict: report.precheck.verdict,
    nextAction: report.precheck.route
  };
}

async function validateBoundPullRequestSummary(
  resolved: ResolvedTaskRef,
  options: PullRequestSummarySyncOptions,
  context: PlatformResult,
  loaded: LoadedContext,
  execution: Parameters<ManagedSummaryPolicy['validate']>[0]
) {
  const latest = await inspectBoundPullRequest(context, resolved.repoRoot, execution.parent, loaded);
  if (!latest.ok) return latest.error;
  if (latest.value.head.sha !== execution.fence.headSha) return { code: 'PR_SUMMARY_HEAD_RACE', message: 'Pull request head changed during managed summary publication', retryable: true };
  const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const bound = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  if (bound.status !== 'valid' || bound.fact.state !== 'bound' || !resourceIdentityEquals(bound.fact.identity.resource, execution.parent)) return { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Bound pull request identity differs from frozen summary target', retryable: true };
  try { await manualValidationEvidence(resolved, execution.fence.manualValidation, execution.body, latest.value); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return { code: value.code || 'MANUAL_VALIDATION_TRANSACTION_REQUIRED', message: value.message || String(error), retryable: false };
  }
  return null;
}

type BoundSummaryState = {
  knownPrNumber: number | null;
  preparedInfo: { precheckVerdict: 'clear' | 'needs-review'; nextAction: 'watch-pr' | 'review-code' } | null;
};

async function runBoundSummaryOperation(
  options: PullRequestSummarySyncOptions,
  expectedIdentity: ResourceIdentity,
  operation: Parameters<typeof coordinateManagedSummary>[0]['operation'],
  policy: ManagedSummaryPolicy,
  state: BoundSummaryState,
  preserveFailure: (output: PlatformResult, knownPrNumber?: number | null) => PullRequestSummaryResult
): Promise<PullRequestSummaryResult> {
  if (options.skipQueue && !options.queuedOperation) return preserveFailure(platformResult('blocked', { error: {
    code: 'MANAGED_SUMMARY_OPERATION_REQUIRED', message: 'Managed summary recovery requires the existing queued operation identity', retryable: false
  } }), state.knownPrNumber);
  const output = options.queuedOperation
    ? await executeManagedSummary(policy, options.queuedOperation)
    : options.dryRun
      ? await previewManagedSummary(policy, `dry-run:${policy.requestDigest}`)
      : await coordinateManagedSummary({ operation, policy, agent: options.agent, client: options.client });
  if (output.result.error || output.result.status === 'failed' || output.result.status === 'blocked') return preserveFailure({
    ...output.result, resource: { kind: 'pull-request', number: state.knownPrNumber, identity: expectedIdentity }
  }, state.knownPrNumber);
  const info = state.preparedInfo ?? { precheckVerdict: 'needs-review' as const, nextAction: 'review-code' as const };
  return {
    ...output.result, resource: { kind: 'pull-request', number: state.knownPrNumber ?? resourceIdentityNumber(expectedIdentity), identity: expectedIdentity },
    comment: output.result.comment ? { ...output.result.comment, kind: 'summary' } : null,
    result: null, warnings: [], ...info
  };
}

function boundPullRequestSummaryPolicy(
  resolved: ResolvedTaskRef,
  options: PullRequestSummarySyncOptions,
  context: PlatformResult,
  loaded: LoadedContext,
  expectedIdentity: ResourceIdentity,
  requestDigest: string,
  state: BoundSummaryState
): ManagedSummaryPolicy {
  return {
    kind: 'pull-request-summary', taskRef: resolved.taskId, target: JSON.stringify(expectedIdentity), requestDigest,
    dependency: 'deferred', cwd: resolved.repoRoot, client: options.client, loaded, agent: options.agent,
    prepare: async () => {
      const prepared = await prepareBoundPullRequestSummary(resolved, options, context, loaded, expectedIdentity);
      state.knownPrNumber = prepared.prNumber;
      state.preparedInfo = { precheckVerdict: prepared.precheckVerdict, nextAction: prepared.nextAction };
      return prepared.summary;
    },
    validate: (execution) => validateBoundPullRequestSummary(resolved, options, context, loaded, execution)
  };
}

async function syncBoundPullRequestSummary(
  resolved: ResolvedTaskRef,
  options: PullRequestSummarySyncOptions,
  context: PlatformResult,
  loaded: LoadedContext,
  expectedIdentity: ResourceIdentity,
  preserveFailure: (output: PlatformResult, knownPrNumber?: number | null) => PullRequestSummaryResult
): Promise<PullRequestSummaryResult> {
  const state: BoundSummaryState = { knownPrNumber: resourceIdentityNumber(expectedIdentity), preparedInfo: null };
  const frozen = options.queuedOperation?.managedSummary?.execution;
  const requestDigest = createHash('sha256').update(JSON.stringify({ body: options.body, changeReportFile: options.changeReportFile, manualValidation: options.manualValidation ?? null })).digest('hex');
  const persistedDigest = options.queuedOperation?.managedSummary?.requestDigest;
  if (options.queuedOperation?.managedSummary && !frozen && persistedDigest !== requestDigest) return preserveFailure(platformResult('blocked', { error: {
    code: 'MANAGED_SUMMARY_REQUEST_CHANGED', message: 'Queued pull-request summary source no longer matches its persisted request digest', retryable: false
  } }), state.knownPrNumber);
  const policy = boundPullRequestSummaryPolicy(resolved, options, context, loaded, expectedIdentity, persistedDigest ?? requestDigest, state);
  const expectedDigest = createHash('sha256').update(options.body).digest('hex');
  const operation = {
    taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: 'pull-request-summary' as const,
    target: JSON.stringify(expectedIdentity), expectedDigest, dependency: 'deferred' as const,
    pullRequestSummary: {
      body: options.body, changeReportFile: options.changeReportFile ?? taskReportPath(resolved.taskDir),
      ...(options.manualValidation?.transactionId ? { manualValidation: { ...options.manualValidation, transactionId: options.manualValidation.transactionId } } : {})
    }
  };
  return runBoundSummaryOperation(options, expectedIdentity, operation, policy, state, preserveFailure);
}

type PreparedSummarySync = Readonly<{
  ok: true;
  resolved: ResolvedTaskRef;
  fact: ReturnType<typeof readPrDeliveryFact>;
  knownPrNumber: number | null;
  loaded: LoadedContext;
  context: PlatformResult;
}> | Readonly<{
  ok: false;
  knownPrNumber: number | null;
  error: PlatformResult;
}>;

function validateUnboundPrSummaryInput(options: PullRequestSummarySyncOptions, taskContent: string, knownPrNumber: number | null): PlatformResult | null {
  try { prepareAndRenderPrSummaryContent(JSON.parse(options.body), taskContent); return null; }
  catch (error) {
    return platformResult('failed', {
      resource: { kind: 'pull-request', number: knownPrNumber },
      error: { code: 'PR_SUMMARY_CONTENT_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
}

function boundSummaryPhase(raw: unknown): { passed: boolean; known: boolean } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const manual = input.manualValidation && typeof input.manualValidation === 'object' && !Array.isArray(input.manualValidation)
    ? input.manualValidation as Record<string, unknown> : {};
  const state = typeof manual.state === 'string' ? manual.state : null;
  const overview = typeof input.overview === 'string' ? input.overview : '';
  return {
    passed: state === 'passed' || /###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)/u.test(overview),
    known: state !== null || overview.length > 0
  };
}

function manualSummaryPhaseFailure(options: PullRequestSummarySyncOptions, phase: { passed: boolean; known: boolean }): { code: string; message: string } | null {
  const manual = options.manualValidation;
  if (phase.passed && (manual?.phase !== 'final' || manual.authority !== 'coordinator')) return {
    code: 'MANUAL_VALIDATION_TRANSACTION_REQUIRED', message: 'final manual-validation summary requires the transaction coordinator'
  };
  if (!manual || !phase.known) return null;
  if ((manual.phase === 'pending' && phase.passed) || (manual.phase === 'final' && !phase.passed)) return {
    code: 'MANUAL_VALIDATION_SUMMARY_PHASE_INVALID', message: 'manual-validation summary phase does not match the requested writer phase'
  };
  return null;
}

function boundSummaryPhaseError(options: PullRequestSummarySyncOptions, raw: unknown, knownPrNumber: number | null): PlatformResult | null {
  const phase = boundSummaryPhase(raw);
  if (!phase) return null;
  const error = manualSummaryPhaseFailure(options, phase);
  return error ? platformResult('failed', { resource: { kind: 'pull-request', number: knownPrNumber }, error: { ...error, retryable: false } }) : null;
}

function validateBoundPrSummaryInput(options: PullRequestSummarySyncOptions, knownPrNumber: number | null): PlatformResult | null {
  if (options.queuedOperation?.managedSummary?.execution) return null;
  try {
    return boundSummaryPhaseError(options, JSON.parse(options.body), knownPrNumber);
  }
  catch (error) {
    return platformResult('failed', {
      resource: { kind: 'pull-request', number: knownPrNumber },
      error: { code: 'PR_SUMMARY_CONTENT_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
}

async function prepareSummarySync(taskRef: string, options: PullRequestSummarySyncOptions): Promise<PreparedSummarySync> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false, knownPrNumber: null, error: platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }) };
  const knownPrNumber = boundPrNumberForWarning(resolved.taskMdPath);
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(taskContent), options.runtimeVersion);
  if (fact.status === 'invalid') return { ok: false, knownPrNumber, error: platformResult('failed', { error: { code: fact.error.code, message: fact.error.message, retryable: false } }) };
  const isBound = fact.status === 'valid' && fact.fact.state === 'bound';
  const contentError = isBound
    ? validateBoundPrSummaryInput(options, knownPrNumber)
    : validateUnboundPrSummaryInput(options, taskContent, knownPrNumber);
  if (contentError) return { ok: false, knownPrNumber, error: contentError };
  if (!options.changeReportFile && (options.dryRun || fact.status !== 'valid' || fact.fact.state !== 'bound')) return {
    ok: false, knownPrNumber, error: platformResult('failed', { error: { code: 'PR_CHANGE_REPORT_MISSING', message: 'summary-sync requires --change-report-file', retryable: false } })
  };
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return { ok: false, knownPrNumber, error: context };
  return { ok: true, resolved, fact, knownPrNumber, loaded: loaded.value, context };
}

async function inspectBoundPullRequest(
  context: PlatformResult,
  repoRoot: string,
  prIdentity: ResourceIdentity,
  loadedContext?: LoadedContext
): Promise<{ ok: true; value: PlatformChangeRequestSnapshot } | { ok: false; error: PlatformResult['error']; status: PlatformResult['status'] }> {
  if (!context.platform.repository) {
    return { ok: false, status: context.status, error: context.error };
  }
  const loaded = loadedContext
    ? { ok: true as const, value: loadedContext }
    : await resolvePlatformProviderContext({ cwd: repoRoot });
  if (!loaded.ok) return { ok: false, status: loaded.context.status, error: loaded.context.error };
  const inspected = loaded.value.provider.changeRequests?.inspect
    ? await loaded.value.provider.changeRequests.inspect({ context: providerOperationContext(loaded.value), target: prIdentity })
    : unsupportedProviderOperation(loaded.value.provider, 'changeRequests.inspect');
  if (!inspected.ok) {
    const error = providerError(inspected.error, 'PLATFORM_PROVIDER_OPERATION_FAILED');
    return { ok: false, status: inspectionError(error), error };
  }
  const remote: ChangeRequestSnapshot = inspected.value;
  if (!remote.identity) {
    return {
      ok: false,
      status: 'failed',
      error: { code: 'PR_IDENTITY_MISSING', message: 'Provider pull-request inspection did not return a canonical identity', retryable: false }
    };
  }
  if (!resourceIdentityEquals(remote.identity, prIdentity)) {
    return {
      ok: false,
      status: 'failed',
      error: { code: 'PR_IDENTITY_MISMATCH', message: 'Provider returned a different pull request identity than requested', retryable: false }
    };
  }
  const number = remote.number ?? resourceIdentityNumber(remote.identity) ?? resourceIdentityNumber(prIdentity) ?? 0;
  const head = remote.head || { repository: context.platform.repository, ref: '', sha: remote.headSha || '' };
  const base = remote.base || { repository: context.platform.repository, ref: '', sha: remote.baseSha || '' };
  return {
    ok: true,
    value: {
      repository: context.platform.repository,
      number,
      identity: remote.identity,
      nodeId: remote.id,
      url: remote.displayUrl || '',
      state: remote.state === 'closed' ? 'closed' : 'open',
      title: remote.title,
      body: remote.body,
      draft: remote.draft ?? false,
      head: { ...head, sha: remote.headSha || head.sha },
      base: { ...base, sha: remote.baseSha || base.sha },
      mergedAt: remote.mergedAt ?? null,
      mergeCommitSha: remote.mergeCommitSha ?? null,
      labels: [...(remote.labels || [])].sort(),
      assignees: [...(remote.assignees || [])].sort(),
      milestone: remote.milestone ?? null,
      mergeability: remote.mergeability || { state: 'unknown', detail: null }
    }
  };
}

function sameIdentity(left: PlatformChangeRequestSnapshot, right: PlatformChangeRequestSnapshot): boolean {
  return JSON.stringify({
    repository: left.repository,
    identity: left.identity ?? null,
    base: left.base,
    head: left.head
  }) === JSON.stringify({
    repository: right.repository,
    identity: right.identity ?? null,
    base: right.base,
    head: right.head
  });
}

function identityFromSnapshot(snapshot: PlatformChangeRequestSnapshot) {
  if (!snapshot.identity) throw new Error('pull-request snapshot has no canonical identity');
  return {
    repository: snapshot.repository,
    resource: snapshot.identity,
    base: { ...snapshot.base },
    head: { ...snapshot.head }
  };
}

function readJsonInput(file: string): { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: {
        code: errno === 'ENOENT' ? 'PR_CHANGE_REPORT_INPUT_MISSING' : 'PR_CHANGE_REPORT_INPUT_INVALID',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    };
  }
}

function sameMechanical(left: MechanicalChangeReport, right: MechanicalChangeReport): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentReportCheck(
  report: PrChangeReport,
  snapshot: PlatformChangeRequestSnapshot,
  taskContent: string,
  repoRoot: string
): { ok: true; digest: string; mechanical: MechanicalChangeReport } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) return { ok: false, error: platformError(digest.error) };
  const reportIdentity = report.identity;
  if (reportIdentity.repository !== snapshot.repository || !resourceIdentityEquals(reportIdentity.resource, snapshot.identity) ||
      JSON.stringify(reportIdentity.base) !== JSON.stringify(snapshot.base) || JSON.stringify(reportIdentity.head) !== JSON.stringify(snapshot.head)) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report identity does not match the authoritative pull request snapshot', retryable: false }
  };
  if (report.inputs.taskIntentSha256 !== digest.value.sha256) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report task intent digest is stale', retryable: false }
  };
  let mechanical: MechanicalChangeReport;
  try {
    mechanical = runMechanicalChangeReport(repoRoot, snapshot.base.sha, snapshot.head.sha);
  } catch (error) {
    return { ok: false, error: { code: 'PR_CHANGE_REPORT_GIT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
  const reportMechanical: MechanicalChangeReport = {
    version: 1,
    base: snapshot.base.sha,
    head: snapshot.head.sha,
    mergeBase: report.diff.mergeBase,
    patchSha256: report.diff.patchSha256,
    files: report.diff.files,
    totals: report.diff.totals
  };
  if (!sameMechanical(reportMechanical, mechanical)) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report patch or mechanical statistics are stale', retryable: false }
  };
  return { ok: true, digest: digest.value.sha256, mechanical };
}

function summaryReportStatus(
  reportPath: string,
  snapshot: PlatformChangeRequestSnapshot | null,
  taskContent: string,
  repoRoot: string
): { status: ChangeReportState; taskIntentSha256: string | null; reason?: string } {
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) return { status: 'invalid', taskIntentSha256: null, reason: digest.error.message };
  const report = readPrChangeReport(reportPath);
  if (!report.ok) return { status: report.error.code === 'PR_CHANGE_REPORT_MISSING' ? 'missing' : 'invalid', taskIntentSha256: digest.value.sha256, reason: report.error.message };
  if (!snapshot) return { status: 'stale', taskIntentSha256: digest.value.sha256, reason: 'No bound pull request snapshot is available' };
  const checked = currentReportCheck(report.value, snapshot, taskContent, repoRoot);
  return checked.ok
    ? { status: 'ready', taskIntentSha256: checked.digest }
    : { status: checked.error.code === 'PR_CHANGE_REPORT_STALE' ? 'stale' : 'invalid', taskIntentSha256: digest.value.sha256, reason: checked.error.message };
}

async function summaryContext(taskRef: string, options: SummaryOptions = {}): Promise<SummaryContextResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return {
    ...platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }),
    task: { id: resolved.taskId, prNumber: null }, pullRequest: null,
    changeReport: { status: 'invalid', path: '', taskIntentSha256: null, reason: resolved.message }, artifacts: []
  };
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(taskContent);
  const reportPath = taskReportPath(resolved.taskDir);
  const fact = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  if (fact.status === 'invalid') return {
    ...platformResult('failed', { error: { code: fact.error.code, message: fact.error.message, retryable: false } }),
    task: { id: resolved.taskId, prNumber: null },
    pullRequest: null,
    changeReport: { status: 'invalid', path: reportPath, taskIntentSha256: null, reason: fact.error.message },
    artifacts: []
  };
  const prIdentity = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.resource : null;
  let prNumber = resourceIdentityNumber(prIdentity);
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  let pullRequest: PlatformChangeRequestSnapshot | null = null;
  if (loaded.ok && prIdentity && context.platform.repository && ['no-op', 'degraded'].includes(context.status)) {
    const inspected = await inspectBoundPullRequest(context, resolved.repoRoot, prIdentity, loaded.value);
    if (inspected.ok) {
      pullRequest = inspected.value;
      if (Number.isSafeInteger(inspected.value.number) && inspected.value.number > 0) {
        prNumber = inspected.value.number;
      }
    }
  }
  const report = summaryReportStatus(reportPath, pullRequest, taskContent, resolved.repoRoot);
  return {
    ...platformResult(context.status, {
      platform: context.platform,
      capabilities: context.capabilities,
      operations: context.operations,
      error: context.error
    }),
    task: { id: resolved.taskId, prNumber },
    pullRequest,
    changeReport: { status: report.status, path: reportPath, taskIntentSha256: report.taskIntentSha256, ...(report.reason ? { reason: report.reason } : {}) },
    artifacts: canonicalArtifacts(resolved.taskDir)
  };
}

async function summaryCommentState(taskRef: string, options: SummaryOptions = {}): Promise<SummaryCommentStateResult> {
  const context = await summaryContext(taskRef, options);
  const prIdentity = context.pullRequest?.identity;
  if (!prIdentity) return { ...context, comment: null };
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client });
  if (!loaded.ok || !loaded.value.provider.comments?.list) return { ...context, comment: null };
  const listed = await loaded.value.provider.comments.list({
    context: providerOperationContext(loaded.value),
    parent: prIdentity
  });
  if (!listed.ok) return { ...context, comment: null };
  const matches = listed.value.filter((comment) => comment.body.includes(summaryMarker(context.task.id!)));
  return {
    ...context,
    comment: matches.length === 1 ? { id: /^\d+$/u.test(matches[0]!.id) ? Number(matches[0]!.id) : matches[0]!.id, body: matches[0]!.body } : null
  };
}

type ReportWriteOptions = {
  agent: string;
  mechanicalFile: string;
  precheckFile: string;
  cwd?: string;
  client?: PlatformClient;
  dryRun?: boolean;
};

async function reportWrite(taskRef: string, options: ReportWriteOptions): Promise<ReportWriteResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ...platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }), report: null };
  let preflight: ReturnType<typeof readBoundTaskSnapshot>;
  try {
    preflight = readBoundTaskSnapshot(resolved.taskMdPath);
  } catch (error) {
    return {
      ...platformResult('failed', { error: { code: 'PR_CHANGE_REPORT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } }),
      report: null
    };
  }
  if (preflight.factError) return {
    ...platformResult('failed', { error: { code: preflight.factError.code, message: preflight.factError.message, retryable: false } }),
    report: null
  };
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return { ...context, report: null };
  let knownPrNumber: number | null = null;
  try {
    return await (async () => {
      const { taskContent, boundFact, factError } = readBoundTaskSnapshot(resolved.taskMdPath);
      if (factError) return {
        ...basePlatformResult('failed', context, resolved.taskId, null, { code: factError.code, message: factError.message, retryable: false }),
        report: null
      };
      if (!boundFact) return {
        ...basePlatformResult('failed', context, resolved.taskId, null, { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }),
        report: null
      };
      const boundPrIdentity = boundFact.identity.resource;
      const boundPrNumber = resourceIdentityNumber(boundPrIdentity);
      knownPrNumber = boundPrNumber;
      const initial = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrIdentity, loaded.value);
      if (!initial.ok) return { ...basePlatformResult(initial.status, context, resolved.taskId, boundPrNumber, initial.error), report: null };
      const digest = taskIntentDigest(taskContent);
      if (!digest.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(digest.error)), report: null };
      const mechanicalInput = readJsonInput(path.resolve(resolved.repoRoot, options.mechanicalFile));
      if (!mechanicalInput.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, mechanicalInput.error), report: null };
      const mechanical = validateMechanicalReport(mechanicalInput.value);
      if (!mechanical.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(mechanical.error)), report: null };
      const candidateInput = readJsonInput(path.resolve(resolved.repoRoot, options.precheckFile));
      if (!candidateInput.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, candidateInput.error), report: null };
      const candidate = validatePrecheckCandidate(candidateInput.value);
      if (!candidate.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(candidate.error)), report: null };
      let recomputed: MechanicalChangeReport;
      try {
        recomputed = runMechanicalChangeReport(resolved.repoRoot, initial.value.base.sha, initial.value.head.sha);
      } catch (error) {
        return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_GIT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }), report: null };
      }
      if (!sameMechanical(mechanical.value, recomputed)) return {
        ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_MECHANICAL_MISMATCH', message: 'Mechanical report input does not match the current complete diff', retryable: false }),
        report: null
      };
      const built = buildPrChangeReport(identityFromSnapshot(initial.value), digest.value.sha256, mechanical.value, candidate.value);
      if (!built.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(built.error)), report: null };
      const final = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrIdentity, loaded.value);
      if (!final.ok) return { ...basePlatformResult(final.status, context, resolved.taskId, boundPrNumber, final.error), report: null };
      if (!sameIdentity(initial.value, final.value)) return {
        ...basePlatformResult('blocked', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_HEAD_RACE', message: 'Pull request identity changed while generating the change report', retryable: true }),
        report: null
      };
      const target = taskReportPath(resolved.taskDir);
      const existing = readPrChangeReport(target);
      const reportInfo = {
        path: target,
        precheckVerdict: built.value.precheck.verdict,
        nextAction: built.value.precheck.route
      } as const;
      if (existing.ok && JSON.stringify(existing.value) === JSON.stringify(built.value)) return {
        ...basePlatformResult('no-op', context, resolved.taskId, boundPrNumber),
        report: { ...reportInfo, status: 'no-op' }
      };
      if (options.dryRun) return {
        ...basePlatformResult('planned', context, resolved.taskId, boundPrNumber),
        operations: [{ name: 'change-report:write', status: 'planned', reasonCode: null }],
        report: { ...reportInfo, status: 'planned' }
      };
      try {
        writePrChangeReportAtomic(target, built.value);
      } catch (error) {
        return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_WRITE_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }), report: null };
      }
      return {
        ...basePlatformResult('applied', context, resolved.taskId, boundPrNumber),
        operations: [{ name: 'change-report:write', status: 'applied', reasonCode: null }],
        report: { ...reportInfo, status: 'written' }
      };
    })();
  } catch (error) {
    return { ...basePlatformResult('failed', context, resolved.taskId, knownPrNumber, { code: 'PR_CHANGE_REPORT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }), report: null };
  }
}

async function syncPullRequestSummary(
  taskRef: string,
  options: PullRequestSummarySyncOptions
): Promise<PullRequestSummaryResult> {
  const warningResult = warningResultForPrimary(options.primaryResult);
  let knownPrNumber: number | null = null;
  const softenFailure = (output: PlatformResult, fallbackNumber = knownPrNumber): PullRequestSummaryResult => {
    const prNumber = output.resource.kind === 'pull-request' && output.resource.number
      ? output.resource.number
      : fallbackNumber;
    const warning = output.error && prNumber && output.error.code !== 'PR_NOT_LINKED'
      ? {
        code: output.error.code,
        message: output.error.message,
        retryable: output.error.retryable,
        step: 'pr-summary',
        target: `pull-request:${prNumber}`,
        severity: 'ACTION_REQUIRED' as const
      }
      : null;
    return warning
      ? {
        ...output,
        status: 'applied',
        changed: false,
        resource: { kind: 'pull-request', number: prNumber },
        error: null,
        result: warningResult,
        warnings: [warning]
      }
      : { ...output, result: null, warnings: [] };
  };
  const preserveFailure = (output: PlatformResult, fallbackNumber = knownPrNumber): PullRequestSummaryResult => options.strict
    || isHardSummaryFailure(output.error)
    ? { ...output, result: null, warnings: [] }
    : softenFailure(output, fallbackNumber);
  const prepared = await prepareSummarySync(taskRef, options);
  if (!prepared.ok) return preserveFailure(prepared.error, prepared.knownPrNumber);
  const { resolved, fact, loaded, context } = prepared;
  knownPrNumber = prepared.knownPrNumber;
  if (fact.status === 'valid' && fact.fact.state === 'bound') {
    return syncBoundPullRequestSummary(resolved, options, context, loaded, fact.fact.identity.resource, preserveFailure);
  }
  return preserveFailure(platformResult(options.dryRun || options.skipQueue ? 'blocked' : 'failed', { error: {
    code: options.skipQueue ? 'MANAGED_SUMMARY_OPERATION_REQUIRED' : 'PR_NOT_LINKED',
    message: options.skipQueue ? 'Managed summary recovery requires the existing queued operation identity' : 'Task has no verified bound pull request',
    retryable: false
  } }));
}

async function recoverManagedPullRequestSummary(taskId: string, operation: JournalOperation, options: { agent: string; cwd: string; client?: PlatformClient }): Promise<PlatformResult> {
  if (!operation.managedSummary) return platformResult('blocked', { error: { code: 'MANAGED_SUMMARY_EXECUTION_EVIDENCE_MISSING', message: 'Pull-request summary has no managed execution intent', retryable: true } });
  const intent = operation.pullRequestSummary;
  if (!intent) return platformResult('blocked', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Queued pull-request summary content is missing', retryable: false } });
  const replayed = await syncPullRequestSummary(taskId, {
    agent: options.agent, cwd: options.cwd, client: options.client, body: intent.body,
    changeReportFile: intent.changeReportFile, ...(intent.manualValidation ? { manualValidation: intent.manualValidation } : {}),
    primaryResult: 'no_op', strict: true, skipQueue: true, queuedOperation: operation
  });
  return (replayed.status === 'applied' || replayed.status === 'no-op') && !replayed.error && replayed.warnings.length === 0
    ? replayed
    : platformResult('blocked', { resource: replayed.resource, error: replayed.error ?? {
      code: 'PR_SUMMARY_RECOVERY_UNCONFIRMED', message: 'Pull-request summary preparation or recovery did not confirm the frozen operation', retryable: true
    } });
}

function correctPrSummaryContent(value: unknown, taskContent: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parsePrSummaryContent(value);
  const input = { ...(value as Record<string, unknown>) };
  const ledger = parseLedgerDocument(taskContent);
  if (ledger.present) {
    const decisions = ledger.rows.filter((row) => row.id.startsWith('HD-'));
    const open = decisions.filter((row) => row.status === 'needs-human-decision').length;
    const resolved = decisions.filter((row) => row.status === 'human-decided').length;
    const current = input.humanDecisions && typeof input.humanDecisions === 'object' && !Array.isArray(input.humanDecisions)
      ? { ...(input.humanDecisions as Record<string, unknown>) }
      : {};
    if (!Number.isSafeInteger(current.open) || Number(current.open) < 0) current.open = open;
    if (!Number.isSafeInteger(current.resolved) || Number(current.resolved) < 0) current.resolved = resolved;
    if (typeof current.detail !== 'string' || !current.detail.trim()) current.detail = `Task decision ledger: ${open} open, ${resolved} resolved.`;
    input.humanDecisions = current;
  }
  return input;
}

export function prepareAndRenderPrSummaryContent(value: unknown, taskContent: string) {
  return runSummaryContentPipeline(value, {
    validate: parsePrSummaryContent,
    correct: (input) => correctPrSummaryContent(input, taskContent),
    render: renderPrSummaryContent
  });
}

export {
  buildPullRequestSummary,
  reportWrite,
  summaryCommentState,
  summaryContext,
  summaryMarker,
  syncPullRequestSummary,
  recoverManagedPullRequestSummary,
  warningResultForPrimary
};
export type { ManualValidationSummaryOptions, PullRequestSummaryResult, ReportWriteOptions, ReportWriteResult, SummaryCommentStateResult, SummaryContextResult };
