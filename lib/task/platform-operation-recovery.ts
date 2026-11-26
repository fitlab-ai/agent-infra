import { execNoInput } from '../exec-no-input.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';


import { inspectPlatformCommentOperation, syncPlatformComment } from '../platform/issue-comments.ts';
import { parseDeliverySummaryContent, renderDeliverySummaryContent, parseCancelSummaryContent, renderCancelSummaryContent } from '../platform/issue-summary-content.ts';
import { enumerateArtifacts } from './artifacts.ts';
import { inspectPlatformIssue, syncPlatformIssue } from '../platform/issues.ts';
import '../platform/context.ts';
import '../platform/provider-bridge.ts';
import { inLabelMappingDigest } from '../platform/in-label-sync.ts';
import { bindPlatformPullRequest, recoverCreatedPullRequest, syncPlatformPullRequest } from '../platform/pull-requests.ts';
import { replayPullRequestSummary } from '../platform/pr-summary.ts';
import { publishPrReview, readReviewBodyFile } from '../platform/pr-review.ts';
import type { PlatformClient } from '../platform/context.ts';
import { parseTaskFrontmatter, parseTypedTaskFrontmatter } from './frontmatter.ts';
import { readPrDeliveryFact } from './pr-delivery-fact.ts';
import { taskIssueIdentity } from '../platform/task-identities.ts';
import { parseResourceIdentity, resourceIdentityEquals } from '../platform/resource-identity.ts';
import { operationId } from './platform-operation-journal.ts';
import { canonicalizeSummaryBody } from '../platform/comment-safety.ts';
import { platformResult } from '../platform/types.ts';
import type { PlatformResult } from '../platform/types.ts';
import { mergeOperationWarnings, type OperationWarning } from './operation-outcome.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from './platform-operation-journal.ts';
import '../platform/provider-validation.ts';

type RecoveryOptions = Readonly<{ agent: string; client?: PlatformClient; cwd?: string; limit?: number; attempts?: number; excludeId?: string; beforeId?: string }>;
const DEFAULT_RECOVERY_ATTEMPTS = 3;
type RecoveryResult = Readonly<{
  status: 'applied' | 'no-op' | 'blocked' | 'failed';
  changed: boolean;
  recovered: readonly string[];
  pending: readonly string[];
  error: { code: string; message: string } | null;
  degraded?: readonly { id: string; reasonCode: string }[];
  warnings?: readonly OperationWarning[];
}>;
type RecoveryError = { code: string; message: string; retryable?: boolean };

function labelsMatchOwnedPrefix(actual: readonly string[], expected: readonly string[], prefix: 'status:' | 'in:'): boolean {
  return actual.filter((label) => label.startsWith(prefix)).sort().join('\0')
    === expected.filter((label) => label.startsWith(prefix)).sort().join('\0');
}

function fieldsMatchExpected(
  actual: Readonly<Record<string, string | number | null>>,
  expected: Readonly<Record<string, string | number | null>>
): boolean {
  return Object.entries(expected).every(([name, value]) => actual[name] === value);
}

function result(status: RecoveryResult['status'], recovered: string[], pending: string[], error: RecoveryError | null = null, warnings: readonly OperationWarning[] = []): RecoveryResult {
  return { status, changed: recovered.length > 0, recovered, pending, error: error ? { code: error.code, message: error.message } : null, ...(warnings.length ? { warnings } : {}) };
}

function summaryPayload(taskDir: string, taskId: string): { body: string; sha256: string } | null {
  const file = path.join(taskDir, '.delivery-summary.json');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { taskId?: unknown; content?: unknown; contentSha256?: unknown };
  let content;
  try { content = parseDeliverySummaryContent(data.content); }
  catch { content = null; }
  if (data.taskId !== taskId || !content || content.taskId !== taskId || typeof data.contentSha256 !== 'string'
    || createHash('sha256').update(JSON.stringify(content)).digest('hex') !== data.contentSha256) {
    throw Object.assign(new Error('delivery summary staging record is invalid'), { code: 'SUMMARY_STAGING_INVALID' });
  }
  const canonical = canonicalizeSummaryBody(renderDeliverySummaryContent(content));
  if (!canonical?.ok) throw Object.assign(new Error('delivery summary staging body is not canonical'), { code: 'SUMMARY_STAGING_INVALID' });
  return { body: canonical.value, sha256: createHash('sha256').update(canonical.value).digest('hex') };
}

function cancellationPayload(taskDir: string, taskId: string): string | null {
  const taskPath = path.join(taskDir, 'task.md');
  if (!fs.existsSync(taskPath)) return null;
  const taskContent = fs.readFileSync(taskPath, 'utf8');
  const frontmatter = parseTaskFrontmatter(taskContent);
  const title = /^#\s+(.+)$/mu.exec(taskContent)?.[1]?.trim() || taskId;
  const artifacts = enumerateArtifacts(taskDir).filter((artifact) => artifact.name !== 'task.md').map((artifact) => artifact.name);
  const content = parseCancelSummaryContent({
    taskId,
    title,
    outcome: 'cancelled',
    reason: frontmatter.cancel_reason,
    cancelledAt: frontmatter.cancelled_at,
    lastCompletedArtifact: artifacts.at(-1) ?? null
  });
  return renderCancelSummaryContent(content);
}

async function replayComment(taskId: string, taskDir: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  if (operation.kind === 'task-comment') {
    return syncPlatformComment(taskId, { kind: 'task', agent, cwd, client, dependency: operation.dependency, queuedOperation: operation });
  }
  if (operation.kind === 'artifact-comment') {
    return syncPlatformComment(taskId, { kind: 'artifact', artifact: operation.target, agent, cwd, client, dependency: operation.dependency, queuedOperation: operation });
  }
  if (operation.kind === 'summary-comment') {
    let summary;
    try { summary = summaryPayload(taskDir, taskId); }
    catch (error) { return platformResult('failed', { error: { code: 'SUMMARY_STAGING_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }); }
    if (!summary) return platformResult('blocked', { error: { code: 'SUMMARY_STAGING_MISSING', message: 'delivery summary staging record is unavailable', retryable: true } });
    return syncPlatformComment(taskId, { kind: 'summary', body: summary.body, agent, cwd, client, summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency, queuedOperation: operation });
  }
  if (operation.kind === 'cancel-comment') {
    let body: string | null;
    try { body = cancellationPayload(taskDir, taskId); }
    catch (error) { return platformResult('failed', { error: { code: 'CANCEL_SUMMARY_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }); }
    if (!body) return platformResult('blocked', { error: { code: 'CANCEL_SUMMARY_INVALID', message: 'Cancellation facts are unavailable for recovery', retryable: true } });
    return syncPlatformComment(taskId, { kind: 'cancel', body, agent, cwd, client, dependency: operation.dependency, queuedOperation: operation });
  }
  return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_UNSUPPORTED', message: `operation kind '${operation.kind}' has no registered recovery handler`, retryable: false } });
}

function currentIssueMetadataOperation(taskId: string, taskMdPath: string, repoRoot: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number]) {
  if (operation.kind !== 'issue-metadata' || !operation.issueMetadata) return null;
  const content = fs.readFileSync(taskMdPath, 'utf8');
  const frontmatter = parseTaskFrontmatter(content);
  const identity = taskIssueIdentity(frontmatter);
  if (!identity) return null;
  let fromDiffFiles: string[] | undefined;
  let mappingDigest: string | undefined;
  if (operation.issueMetadata.inLabels === 'from-diff') {
    const taskBase = typeof frontmatter.delivery_base_ref === 'string' ? frontmatter.delivery_base_ref.trim() : '';
    if (!taskBase || (operation.issueMetadata.base && operation.issueMetadata.base !== taskBase)) return null;
    try {
      fromDiffFiles = execNoInput('git', ['diff', `${taskBase}...HEAD`, '--name-only'], {
        cwd: repoRoot, encoding: 'utf8'
      }).trim().split(/\r?\n/).filter(Boolean).sort();
      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { labels?: { in?: unknown } };
      const mapping = inLabelMappingDigest(config.labels?.in);
      if (!mapping.ok) return null;
      mappingDigest = mapping.digest;
    } catch { return null; }
  }
  const currentMetadata = {
    ...operation.issueMetadata,
    ...(fromDiffFiles ? { fromDiffFiles } : {}),
    ...(mappingDigest ? { inLabelMappingDigest: mappingDigest } : {})
  };
  const target = JSON.stringify(identity);
  const expectedDigest = createHash('sha256').update(JSON.stringify({
    ...currentMetadata,
    task: taskId,
    taskContent: createHash('sha256').update(content).digest('hex')
  })).digest('hex');
  return { kind: 'issue-metadata' as const, target, expectedDigest, issueMetadata: currentMetadata, id: operationId({ kind: 'issue-metadata', target, expectedDigest }) };
}

type MetadataOperation = ReturnType<typeof readPlatformOperationJournal>['operations'][number];
type IssueSnapshot = NonNullable<Awaited<ReturnType<typeof inspectPlatformIssue>>['issue']>;

function metadataOperationFailure(sync: Awaited<ReturnType<typeof syncPlatformIssue>>): PlatformResult | null {
  const failed = sync.operations.find((item) => item.status === 'failed' || (item.status === 'skipped'
    && !(sync.capabilities.push === false && ['fields', 'issue-type'].includes(item.name) && item.reasonCode === 'PUSH_REQUIRED')));
  return failed ? platformResult('blocked', { error: {
    code: failed.reasonCode || 'PLATFORM_OPERATION_METADATA_UNCONFIRMED',
    message: `Issue metadata recovery did not confirm operation '${failed.name}'`, retryable: true
  } }) : null;
}

function metadataMatchesIssue(issue: IssueSnapshot, sync: Awaited<ReturnType<typeof syncPlatformIssue>>, metadata: NonNullable<MetadataOperation['issueMetadata']>): boolean {
  const operationUnconfirmed = sync.operations.some((item) => {
    if (!('value' in item) || item.value === undefined) return false;
    if (item.name === 'labels:status' || item.name === 'labels:in') {
      const prefix = item.name === 'labels:status' ? 'status:' : 'in:';
      return !labelsMatchOwnedPrefix(issue.labels, item.value as string[], prefix);
    }
    if (item.name === 'assignees') return [...issue.assignees].sort().join('\0') !== [...item.value as string[]].sort().join('\0');
    if (item.name === 'milestone') return issue.milestone !== item.value;
    if (item.name === 'requirements') return issue.body !== item.value;
    if (item.name === 'state') return issue.state !== item.value;
    if (item.name === 'issue-type') return issue.issueType !== item.value;
    if (item.name === 'fields') return !fieldsMatchExpected(issue.fields, item.value as Record<string, string | number | null>);
    return false;
  });
  return !operationUnconfirmed && !(metadata.state !== undefined && issue.state !== metadata.state)
    && !(metadata.assignees === 'none' && issue.assignees.length !== 0)
    && !(metadata.milestone === 'none' && issue.milestone !== null);
}

function unconfirmedMetadataResult(): PlatformResult {
  return platformResult('blocked', { error: {
    code: 'PLATFORM_OPERATION_METADATA_UNCONFIRMED',
    message: 'Issue metadata differs from the requested recovery target after reread', retryable: true
  } });
}

function parseIssueMetadataIdentity(operation: MetadataOperation): ReturnType<typeof parseResourceIdentity> | null {
  try { return parseResourceIdentity(JSON.parse(operation.target), 'journal Issue identity'); }
  catch { return null; }
}

function issueIdentityFailure(
  inspected: Awaited<ReturnType<typeof inspectPlatformIssue>>,
  expectedIdentity: ReturnType<typeof parseResourceIdentity>,
  message: string
): PlatformResult | null {
  if (inspected.status === 'no-op' && !inspected.error && inspected.issue
    && resourceIdentityEquals(inspected.issue.identity, expectedIdentity)) return null;
  return platformResult('blocked', { error: inspected.error ?? {
    code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message, retryable: false
  } });
}

async function replayIssueMetadata(taskId: string, operation: MetadataOperation, agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  if (!operation.issueMetadata) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Issue metadata recovery parameters are missing', retryable: false } });
  const expectedIdentity = parseIssueMetadataIdentity(operation);
  if (!expectedIdentity) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Journal Issue identity is invalid', retryable: false } });
  const before = await inspectPlatformIssue(taskId, { cwd, client });
  const beforeFailure = issueIdentityFailure(before, expectedIdentity, 'Bound Issue identity differs from the journal target');
  if (beforeFailure) return beforeFailure;
  const sync = await syncPlatformIssue(taskId, { ...operation.issueMetadata, agent, cwd, client, dependency: operation.dependency, skipQueue: true });
  if ((sync.status !== 'applied' && sync.status !== 'no-op') || sync.error) return sync;
  const after = await inspectPlatformIssue(taskId, { cwd, client });
  const afterFailure = issueIdentityFailure(after, expectedIdentity, 'Issue identity changed during metadata recovery');
  if (afterFailure) return afterFailure;
  const failure = metadataOperationFailure(sync);
  if (failure) return failure;
  if (!metadataMatchesIssue(after.issue!, sync, operation.issueMetadata)) return unconfirmedMetadataResult();
  return platformResult('no-op', { changed: sync.changed || after.changed, operations: sync.operations });
}

async function verifyIssueCreate(taskId: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  if (!operation.issueCreate) return platformResult('failed', { error: {
    code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Issue creation recovery identity is missing', retryable: false
  } });
  const current = await inspectPlatformIssue(taskId, { cwd, client });
  if (!current.issue) return platformResult('blocked', { error: current.error ?? {
    code: 'PLATFORM_OPERATION_TARGET_UNAVAILABLE',
    message: 'Issue creation outcome is unknown and the task has no bound Issue identity; bind the verified remote Issue before continuing',
    retryable: true
  } });
  if (current.issue.title !== operation.issueCreate.title
    || createHash('sha256').update(current.issue.body).digest('hex') !== operation.issueCreate.bodyDigest) return platformResult('blocked', { error: {
    code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Bound Issue does not match the queued creation intent', retryable: false
  } });
  return platformResult('no-op');
}

async function replayPullRequestReview(operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  const intent = operation.pullRequestReview;
  if (!intent) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Pull-request review recovery parameters are missing', retryable: false } });
  let target;
  try { target = parseResourceIdentity(JSON.parse(operation.target), 'queued pull-request review identity'); }
  catch { return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Queued pull-request review identity is invalid', retryable: false } }); }
  if (!intent.resource || !resourceIdentityEquals(target, intent.resource)) return platformResult('failed', { error: {
    code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Pull-request review identity differs from the journal target', retryable: false
  } });
  let body: string;
  try { body = readReviewBodyFile(intent.scope, intent.round, intent.artifactFile, intent.bodyDigest, cwd); }
  catch { return platformResult('failed', { error: {
    code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Canonical pull-request review body is unavailable or does not match the queued digest', retryable: false
  } }); }
  return publishPrReview({
    cwd,
    client,
    agent,
    prNumber: intent.prNumber,
    expectedResource: target,
    expectedProviderScopeId: intent.providerScopeId,
    identity: { scope: intent.scope, round: intent.round, commitSha: intent.commitSha, ...(intent.resource ? { resource: intent.resource } : {}) },
    event: intent.event,
    body,
    recoveryArtifact: intent.artifactFile,
    skipQueue: true
  });
}

async function replayPullRequest(taskId: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string): Promise<PlatformResult> {
  const intent = operation.pullRequest;
  if (!intent) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Pull-request recovery parameters are missing', retryable: false } });
  if (intent.action === 'bind') {
    if (!intent.prToken) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Pull-request bind identity is missing', retryable: false } });
    return bindPlatformPullRequest(taskId, { agent, cwd, pr: intent.prToken, skipQueue: true });
  }
  if (intent.action === 'sync') {
    const synced = await syncPlatformPullRequest(taskId, {
      agent, cwd, metadata: intent.metadata === true, closingIssue: intent.closingIssue === true, primaryResult: 'no_op', skipQueue: true
    });
    if (synced.warnings.length > 0 || synced.result?.endsWith('_with_warnings')) {
      return platformResult('blocked', { error: { code: 'PLATFORM_OPERATION_PR_SYNC_UNCONFIRMED', message: 'Pull-request metadata sync remains degraded', retryable: true } });
    }
    return synced;
  }
  return recoverCreatedPullRequest(taskId, { agent, cwd, base: intent.baseRef || '', head: intent.headRef || '', skipQueue: true });
}

function isRecoveryEligible(operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], excludeId?: string): boolean {
  if (operation.id === excludeId) return false;
  if (operation.state === 'queued' || operation.state === 'pending' || operation.state === 'unknown') return true;
  return operation.state === 'failed'
    && operation.lastCode !== 'PLATFORM_OPERATION_SUPERSEDED'
;
}

function recoveryCandidates(journal: ReturnType<typeof readPlatformOperationJournal>, options: RecoveryOptions) {
  const boundary = options.beforeId ? journal.operations.findIndex((item) => item.id === options.beforeId) : journal.operations.length;
  if (boundary < 0) throw Object.assign(new Error('Current platform operation boundary is unavailable'), { code: 'PLATFORM_OPERATION_BOUNDARY_MISSING' });
  return journal.operations.slice(0, boundary).filter((item) => isRecoveryEligible(item, options.excludeId));
}

function recoveryBatch(taskRef: string, selection: 'required' | 'deferred' | 'all', options: RecoveryOptions): { task: ResolvedTask; candidates: ReturnType<typeof recoveryCandidates> } | { failure: RecoveryResult } {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { failure: result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false }) };
  try {
    const candidates = recoveryCandidates(readPlatformOperationJournal(resolved.taskId, resolved.repoRoot), options);
    if (candidates.length && selectedHeadMismatch(candidates, selection)) return { failure: result('blocked', [], candidates.map((operation) => operation.id), {
      code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'The first unresolved platform operation belongs to another recovery selection', retryable: true
    }) };
    return { task: resolved, candidates };
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return { failure: result(value.code === 'PLATFORM_OPERATION_BOUNDARY_MISSING' ? 'blocked' : 'failed', [], [], {
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: value.code === 'PLATFORM_OPERATION_BOUNDARY_MISSING'
    }) };
  }
}

type ResolvedTask = Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
type RecoveryOperation = MetadataOperation;
type RecoveryContext = Readonly<{ taskId: string; taskDir: string; repoRoot: string; operation: RecoveryOperation; options: RecoveryOptions }>;
type RecoveryRemote = PlatformResult & { warnings?: readonly OperationWarning[] };
type RecoveryHandler = (context: RecoveryContext) => Promise<RecoveryRemote>;

const recoveryHandlers: Record<RecoveryOperation['kind'], RecoveryHandler> = {
  'task-comment': ({ taskId, taskDir, repoRoot, operation, options }) => replayComment(taskId, taskDir, operation, options.agent, repoRoot, options.client),
  'artifact-comment': ({ taskId, taskDir, repoRoot, operation, options }) => replayComment(taskId, taskDir, operation, options.agent, repoRoot, options.client),
  'summary-comment': ({ taskId, taskDir, repoRoot, operation, options }) => replayComment(taskId, taskDir, operation, options.agent, repoRoot, options.client),
  'cancel-comment': ({ taskId, taskDir, repoRoot, operation, options }) => replayComment(taskId, taskDir, operation, options.agent, repoRoot, options.client),
  'issue-create': ({ taskId, repoRoot, operation }) => verifyIssueCreate(taskId, operation, repoRoot),
  'issue-metadata': ({ taskId, repoRoot, operation, options }) => replayIssueMetadata(taskId, operation, options.agent, repoRoot),
  'pull-request': ({ taskId, repoRoot, operation, options }) => replayPullRequest(taskId, operation, options.agent, repoRoot),
  'pull-request-summary': ({ taskId, repoRoot, operation, options }) => replayPullRequestSummary(taskId, operation, { agent: options.agent, cwd: repoRoot, client: options.client }),
  'pull-request-review': ({ repoRoot, operation, options }) => replayPullRequestReview(operation, options.agent, repoRoot, options.client)
};

function pendingResult(operationId: string, code: string, message: string, retryable = true): RecoveryResult {
  return result('blocked', [], [operationId], { code, message, retryable });
}

function recordPendingOperation(task: ResolvedTask, operation: RecoveryOperation): void {
  recordPlatformOperation({
    taskRef: task.taskId, cwd: task.repoRoot, kind: operation.kind,
    target: operation.target, expectedDigest: operation.expectedDigest,
    dependency: operation.dependency, state: 'pending',
    ...(operation.issueMetadata ? { issueMetadata: operation.issueMetadata } : {}),
    ...(operation.issueCreate ? { issueCreate: operation.issueCreate } : {}),
    ...(operation.pullRequest ? { pullRequest: operation.pullRequest } : {}),
    ...(operation.pullRequestSummary ? { pullRequestSummary: operation.pullRequestSummary } : {}),
    ...(operation.pullRequestReview ? { pullRequestReview: operation.pullRequestReview } : {})
  });
}

function commentRecoveryOptions(taskId: string, taskDir: string, repoRoot: string, operation: RecoveryOperation, options: RecoveryOptions) {
  if (operation.kind === 'task-comment') return { kind: 'task' as const, agent: options.agent, cwd: repoRoot, dependency: operation.dependency };
  if (operation.kind === 'artifact-comment') return { kind: 'artifact' as const, artifact: operation.target, agent: options.agent, cwd: repoRoot, dependency: operation.dependency };
  if (operation.kind === 'summary-comment') {
    try {
      const summary = summaryPayload(taskDir, taskId);
      return summary ? { kind: 'summary' as const, body: summary.body, agent: options.agent, cwd: repoRoot, summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency } : null;
    } catch { return null; }
  }
  if (operation.kind === 'cancel-comment') {
    try {
      const body = cancellationPayload(taskDir, taskId);
      return body ? { kind: 'cancel' as const, body, agent: options.agent, cwd: repoRoot, dependency: operation.dependency } : null;
    } catch { return null; }
  }
  return undefined;
}

function commentOperation(operation: RecoveryOperation): boolean {
  return operation.kind === 'task-comment' || operation.kind === 'artifact-comment'
    || operation.kind === 'summary-comment' || operation.kind === 'cancel-comment';
}

function replaceOperationRecord(task: ResolvedTask, operation: RecoveryOperation, current: NonNullable<ReturnType<typeof currentIssueMetadataOperation>> | NonNullable<Awaited<ReturnType<typeof inspectPlatformCommentOperation>>>): RecoveryResult | null {
  try {
    recordPlatformOperation({ taskRef: task.taskId, cwd: task.repoRoot, kind: operation.kind, target: operation.target,
      expectedDigest: current.expectedDigest, ...(operation.kind === 'issue-metadata' && 'issueMetadata' in current ? { issueMetadata: current.issueMetadata } : {}),
      dependency: operation.dependency, state: 'queued', replaceOperationId: operation.id });
    return null;
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return pendingResult(operation.id, value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', value.message || String(error));
  }
}

function replaceRecoveryTarget(task: ResolvedTask, operation: RecoveryOperation, options: RecoveryOptions): { targetOperation: RecoveryOperation } | { failure: RecoveryResult } {
  let current: NonNullable<ReturnType<typeof currentIssueMetadataOperation>> | NonNullable<Awaited<ReturnType<typeof inspectPlatformCommentOperation>>> | null;
  if (operation.kind === 'issue-metadata') {
    current = currentIssueMetadataOperation(task.taskId, task.taskMdPath, task.repoRoot, operation);
  } else if (commentOperation(operation)) {
    const commentOptions = commentRecoveryOptions(task.taskId, task.taskDir, task.repoRoot, operation, options);
    current = commentOptions ? inspectPlatformCommentOperation(task.taskId, commentOptions) : null;
  } else return { targetOperation: operation };
  if (!current) return { failure: pendingResult(operation.id, 'PLATFORM_OPERATION_TARGET_UNAVAILABLE', `Current ${operation.kind === 'issue-metadata' ? 'Issue metadata' : 'comment'} target cannot be reconstructed safely`) };
  if (operation.kind === 'issue-metadata' && current.target !== operation.target) return { failure: pendingResult(operation.id, 'PLATFORM_OPERATION_IDENTITY_MISMATCH', 'Bound Issue identity differs from the journal target', false) };
  if (current.id === operation.id) return { targetOperation: operation };
  const failure = replaceOperationRecord(task, operation, current);
  if (failure) return { failure };
  return { targetOperation: { ...operation, expectedDigest: current.expectedDigest, id: current.id,
    ...(operation.kind === 'issue-metadata' && 'issueMetadata' in current ? { issueMetadata: current.issueMetadata } : {}) } };
}

async function runRecoveryHandler(context: RecoveryContext): Promise<RecoveryRemote> {
  try { return await recoveryHandlers[context.operation.kind](context); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return platformResult('blocked', { error: { code: value.code || 'PLATFORM_OPERATION_RECOVERY_FAILED', message: value.message || String(error), retryable: true } });
  }
}

function recoveryIntentFields(operation: RecoveryOperation, targetOperation: RecoveryOperation) {
  return {
    ...(targetOperation.issueMetadata ? { issueMetadata: targetOperation.issueMetadata } : {}),
    ...(operation.issueCreate ? { issueCreate: operation.issueCreate } : {}),
    ...(operation.pullRequest ? { pullRequest: operation.pullRequest } : {}),
    ...(operation.pullRequestSummary ? { pullRequestSummary: operation.pullRequestSummary } : {}),
    ...(operation.pullRequestReview ? { pullRequestReview: operation.pullRequestReview } : {})
  };
}

function recoveryOutcomeInput(task: ResolvedTask, operation: RecoveryOperation, targetOperation: RecoveryOperation, remote: RecoveryRemote) {
  const succeeded = (remote.status === 'applied' || remote.status === 'no-op') && !remote.error;
  const latestOperation = readPlatformOperationJournal(task.taskId, task.repoRoot).operations.find((item) => item.id === operation.id);
  return {
    taskRef: task.taskId, cwd: task.repoRoot, kind: operation.kind, target: operation.target,
    expectedDigest: targetOperation.expectedDigest, ...recoveryIntentFields(operation, targetOperation),
    dependency: operation.dependency, state: succeeded ? 'succeeded' as const : 'unknown' as const,
    lastCode: remote.error?.code ?? remote.operations.find((item) => item.status === 'skipped' && item.reasonCode === 'PUSH_REQUIRED')?.reasonCode ?? (succeeded ? null : latestOperation?.lastCode) ?? null
  };
}

function persistRecoveryOutcome(task: ResolvedTask, operation: RecoveryOperation, targetOperation: RecoveryOperation, remote: RecoveryRemote): RecoveryResult | null {
  try {
    recordPlatformOperation(recoveryOutcomeInput(task, operation, targetOperation, remote));
    return null;
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return pendingResult(operation.id, value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', value.message || String(error));
  }
}

async function recoverSelectedOperation(task: ResolvedTask, operation: RecoveryOperation, options: RecoveryOptions): Promise<RecoveryResult> {
  if (operation.kind === 'pull-request' && operation.pullRequest?.action === 'bind') {
    if (operation.state === 'pending' || operation.state === 'unknown') {
      return pendingResult(operation.id, 'PLATFORM_OPERATION_RECOVERY_PENDING', 'Unresolved bind outcome requires independent verification', false);
    }
    if (operation.state === 'failed' && operation.lastCode === 'PR_BIND_IDENTITY_MISMATCH') {
      const token = operation.pullRequest.prToken;
      const intent = operation.pullRequest;
      const digest = createHash('sha256').update(JSON.stringify({ taskId: task.taskId, intent, identityInput: { pr: token } })).digest('hex');
      let fact: ReturnType<typeof readPrDeliveryFact>;
      try { fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(task.taskMdPath, 'utf8'))); }
      catch { return pendingResult(operation.id, 'PLATFORM_OPERATION_IDENTITY_MISMATCH', 'Existing binding cannot be read safely', false); }
      if (!token || operation.target !== `pr:${token}` || operation.expectedDigest !== digest
        || Object.keys(intent).length !== 2 || fact.status !== 'valid' || fact.fact.state !== 'bound') {
        return pendingResult(operation.id, 'PLATFORM_OPERATION_IDENTITY_MISMATCH', 'Bind intent or existing binding cannot be verified', false);
      }
      const checked = await bindPlatformPullRequest(task.taskId, { agent: options.agent, cwd: task.repoRoot, pr: token, skipQueue: true });
      if (checked.status !== 'no-op' || checked.error || !checked.pullRequest) {
        return pendingResult(operation.id, checked.error?.code || 'PLATFORM_OPERATION_PR_NOT_CONFIRMED', checked.error?.message || 'Current binding could not be verified');
      }
      try {
        recordPlatformOperation({ taskRef: task.taskId, cwd: task.repoRoot, kind: operation.kind, target: operation.target,
          expectedDigest: operation.expectedDigest, dependency: operation.dependency, state: 'succeeded',
          lastCode: operation.lastCode, pullRequest: intent,
          bindRecheck: { headSha: checked.pullRequest.head.sha, baseSha: checked.pullRequest.base.sha, verifiedAt: new Date().toISOString() } });
      } catch (error) {
        return pendingResult(operation.id, 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', String(error));
      }
      return result('applied', [operation.id], [], null);
    }
  }
  try { recordPendingOperation(task, operation); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return pendingResult(operation.id, value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', value.message || String(error));
  }
  const prepared = replaceRecoveryTarget(task, operation, options);
  if ('failure' in prepared) return prepared.failure;
  const targetOperation = prepared.targetOperation;
  const remote = await runRecoveryHandler({ taskId: task.taskId, taskDir: task.taskDir, repoRoot: task.repoRoot, operation: targetOperation, options });
  const succeeded = (remote.status === 'applied' || remote.status === 'no-op') && !remote.error;
  const persistenceFailure = persistRecoveryOutcome(task, operation, targetOperation, remote);
  if (persistenceFailure) return persistenceFailure;
  if (!succeeded) return result(remote.status === 'failed' ? 'failed' : 'blocked', [], [targetOperation.id], remote.error ?? {
    code: 'PLATFORM_OPERATION_RECOVERY_UNKNOWN', message: 'Platform operation outcome remains unknown', retryable: true
  });
  return result('applied', [targetOperation.id], [], null, remote.warnings ?? []);
}

async function recoverPlatformOperationsOnce(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const batch = recoveryBatch(taskRef, selection, options);
  if ('failure' in batch) return batch.failure;
  const { task: resolved, candidates } = batch;
  if (!candidates.length) return result('no-op', [], []);
  const limit = options.limit === undefined ? candidates.length : Math.max(1, options.limit);
  const recovered: string[] = [];
  const pending: string[] = [];
  let warnings: readonly OperationWarning[] = [];
  const selected = candidates.slice(0, limit);
  for (const operation of selected) {
    const recoveredOne = await recoverSelectedOperation(resolved, operation, options);
    if (recoveredOne.recovered.length === 0) return result(recoveredOne.status, [...recovered, ...recoveredOne.recovered], [...pending, ...recoveredOne.pending], recoveredOne.error, mergeOperationWarnings(warnings, recoveredOne.warnings ?? []));
    recovered.push(...recoveredOne.recovered);
    warnings = mergeOperationWarnings(warnings, recoveredOne.warnings ?? []);
  }
  const remaining = candidates.slice(limit).map((operation) => operation.id);
  pending.push(...remaining);
  return result(pending.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, pending, pending.length ? { code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'Platform operations remain pending after the recovery budget', retryable: true } : null, warnings);
}

async function retryRecoveryHead(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions,
  attemptLimit: number,
  recovered: string[],
  warnings: readonly OperationWarning[]
): Promise<{ last: RecoveryResult | null; warnings: readonly OperationWarning[] }> {
  let last: RecoveryResult | null = null;
  let mergedWarnings = warnings;
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    last = await recoverPlatformOperationsOnce(taskRef, selection, { ...options, limit: 1 });
    recovered.push(...last.recovered.filter((id) => !recovered.includes(id)));
    mergedWarnings = mergeOperationWarnings(mergedWarnings, last.warnings ?? []);
    if (last.recovered.length > 0 || last.status === 'applied' || last.status === 'no-op') break;
  }
  return { last, warnings: mergedWarnings };
}

function recoveryHeadSucceeded(last: RecoveryResult | null): boolean {
  return Boolean(last && (last.recovered.length > 0 || last.status === 'applied' || last.status === 'no-op'));
}

function selectedHeadMismatch(candidates: ReturnType<typeof recoveryCandidates>, selection: 'required' | 'deferred' | 'all'): boolean {
  return selection !== 'all' && candidates[0]?.dependency !== selection;
}

function initialRecoveryState(taskRef: string, options: RecoveryOptions): { task: ResolvedTask; candidates: ReturnType<typeof recoveryCandidates> } | { failure: RecoveryResult } {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { failure: result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false }) };
  try { return { task: resolved, candidates: recoveryCandidates(readPlatformOperationJournal(resolved.taskId, resolved.repoRoot), options) }; }
  catch (error) {
    const value = error as { code?: string; message?: string };
    const boundaryMissing = value.code === 'PLATFORM_OPERATION_BOUNDARY_MISSING';
    return { failure: result(boundaryMissing ? 'blocked' : 'failed', [], [], {
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: boundaryMissing
    }) };
  }
}

function readCurrentCandidates(task: ResolvedTask, options: RecoveryOptions): ReturnType<typeof recoveryCandidates> | RecoveryResult {
  try { return recoveryCandidates(readPlatformOperationJournal(task.taskId, task.repoRoot), options); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return result(value.code === 'PLATFORM_OPERATION_BOUNDARY_MISSING' ? 'blocked' : 'failed', [], [], {
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: value.code === 'PLATFORM_OPERATION_BOUNDARY_MISSING'
    });
  }
}

async function recoverNextHead(
  taskRef: string, task: ResolvedTask, selection: 'required' | 'deferred' | 'all', options: RecoveryOptions,
  attemptLimit: number, recovered: string[], warnings: readonly OperationWarning[]
): Promise<{ done: boolean; warnings: readonly OperationWarning[]; failure?: RecoveryResult }> {
  const candidates = readCurrentCandidates(task, options);
  if (!Array.isArray(candidates)) return { done: true, warnings, failure: result(candidates.status, recovered, [...candidates.pending], candidates.error, warnings) };
  const head = candidates[0];
  if (!head) return { done: true, warnings };
  if (selectedHeadMismatch(candidates, selection)) return { done: true, warnings, failure: result('blocked', recovered, candidates.map((operation) => operation.id), {
    code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'The first unresolved platform operation belongs to another recovery selection', retryable: true
  }, warnings) };
  const retry = await retryRecoveryHead(taskRef, selection, options, attemptLimit, recovered, warnings);
  if (recoveryHeadSucceeded(retry.last)) return { done: false, warnings: retry.warnings };
  const pending = readCurrentCandidates(task, options);
  if (!Array.isArray(pending)) return { done: true, warnings: retry.warnings, failure: result('blocked', recovered, [head.id], retry.last?.error ?? pending.error, retry.warnings) };
  return { done: true, warnings: retry.warnings, failure: result(retry.last?.status === 'failed' ? 'failed' : 'blocked', recovered, pending.map((operation) => operation.id), retry.last?.error ?? {
    code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'The first queued platform operation remains unresolved after this recovery run', retryable: true
  }, retry.warnings) };
}

function completedRecoveryResult(task: ResolvedTask, options: RecoveryOptions, recovered: string[], warnings: readonly OperationWarning[]): RecoveryResult {
  const remaining = readCurrentCandidates(task, options);
  if (!Array.isArray(remaining)) return result('blocked', recovered, [], remaining.error ?? { code: 'PLATFORM_OPERATION_JOURNAL_INVALID', message: 'Unable to read platform operations', retryable: false }, warnings);
  const output = result(remaining.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, remaining.map((operation) => operation.id),
    remaining.length ? { code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'Platform operations remain queued after this recovery run', retryable: true } : null, warnings);
  const degraded = readPlatformOperationJournal(task.taskId, task.repoRoot).operations
    .filter((item) => recovered.includes(item.id) && item.lastCode === 'PUSH_REQUIRED').map((item) => ({ id: item.id, reasonCode: item.lastCode! }));
  return degraded.length ? { ...output, degraded } : output;
}

async function recoverPlatformOperations(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const initial = initialRecoveryState(taskRef, options);
  if ('failure' in initial) return initial.failure;
  const { task, candidates } = initial;
  if (!candidates.length) return result('no-op', [], []);
  const operationLimit = options.limit === undefined ? candidates.length : Math.max(1, options.limit);
  const attemptLimit = options.attempts ?? DEFAULT_RECOVERY_ATTEMPTS;
  if (!Number.isSafeInteger(attemptLimit) || attemptLimit <= 0) {
    return result('failed', [], [], { code: 'PLATFORM_OPERATION_RECOVERY_PAYLOAD_INVALID', message: 'Recovery attempts must be a positive safe integer', retryable: false });
  }
  const recovered: string[] = [];
  let warnings: readonly OperationWarning[] = [];

  for (let operationIndex = 0; operationIndex < operationLimit; operationIndex += 1) {
    const next = await recoverNextHead(taskRef, task, selection, options, attemptLimit, recovered, warnings);
    warnings = next.warnings;
    if (next.failure) return next.failure;
    if (next.done) break;
  }
  return completedRecoveryResult(task, options, recovered, warnings);
}

export { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverPlatformOperations };
export type { RecoveryOptions, RecoveryResult };
