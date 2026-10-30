import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
import { parseTaskFrontmatter } from './frontmatter.ts';
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
      fromDiffFiles = execFileSync('git', ['diff', `${taskBase}...HEAD`, '--name-only'], {
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

async function replayIssueMetadata(taskId: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  if (!operation.issueMetadata) return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Issue metadata recovery parameters are missing', retryable: false } });
  let expectedIdentity;
  try { expectedIdentity = parseResourceIdentity(JSON.parse(operation.target), 'journal Issue identity'); }
  catch { return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Journal Issue identity is invalid', retryable: false } }); }
  const before = await inspectPlatformIssue(taskId, { cwd, client });
  if (before.status !== 'no-op' || before.error || !before.issue
    || !resourceIdentityEquals(before.issue.identity, expectedIdentity)) {
    return platformResult('blocked', { error: before.error ?? { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Bound Issue identity differs from the journal target', retryable: false } });
  }
  const sync = await syncPlatformIssue(taskId, { ...operation.issueMetadata, agent, cwd, client, dependency: operation.dependency, skipQueue: true });
  if ((sync.status !== 'applied' && sync.status !== 'no-op') || sync.error) return sync;
  const after = await inspectPlatformIssue(taskId, { cwd, client });
  if (after.status !== 'no-op' || after.error || !after.issue
    || !resourceIdentityEquals(after.issue.identity, expectedIdentity)) {
    return platformResult('blocked', { error: after.error ?? { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Issue identity changed during metadata recovery', retryable: false } });
  }
  const issue = after.issue;
  const metadata = operation.issueMetadata;
  const failedOperation = sync.operations.find((item) => item.status === 'failed' || (item.status === 'skipped'
    && !(sync.capabilities.push === false && ['fields', 'issue-type'].includes(item.name) && item.reasonCode === 'PUSH_REQUIRED')));
  if (failedOperation) return platformResult('blocked', { error: {
    code: failedOperation.reasonCode || 'PLATFORM_OPERATION_METADATA_UNCONFIRMED',
    message: `Issue metadata recovery did not confirm operation '${failedOperation.name}'`, retryable: true
  } });
  const unconfirmed = sync.operations.some((item) => {
    if (!('value' in item) || item.value === undefined) return false;
    if (item.name === 'labels:status' || item.name === 'labels:in') {
      const prefix = item.name === 'labels:status' ? 'status:' : 'in:';
      return !labelsMatchOwnedPrefix(issue!.labels, item.value as string[], prefix);
    }
    if (item.name === 'assignees') return [...issue!.assignees].sort().join('\0') !== [...item.value as string[]].sort().join('\0');
    if (item.name === 'milestone') return issue!.milestone !== item.value;
    if (item.name === 'requirements') return issue!.body !== item.value;
    if (item.name === 'state') return issue!.state !== item.value;
    if (item.name === 'issue-type') return issue!.issueType !== item.value;
    if (item.name === 'fields') return !fieldsMatchExpected(issue!.fields, item.value as Record<string, string | number | null>);
    return false;
  }) || (metadata.state !== undefined && issue!.state !== metadata.state)
    || (metadata.assignees === 'none' && issue!.assignees.length !== 0)
    || (metadata.milestone === 'none' && issue!.milestone !== null);
  if (unconfirmed) return platformResult('blocked', { error: {
    code: 'PLATFORM_OPERATION_METADATA_UNCONFIRMED',
    message: 'Issue metadata differs from the requested recovery target after reread', retryable: true
  } });
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

async function recoverPlatformOperationsOnce(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false });
  let journal;
  try { journal = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return result('failed', [], [], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: false });
  }
  let candidates;
  try { candidates = recoveryCandidates(journal, options); }
  catch (error) { const value = error as { code: string; message: string }; return result('blocked', [], [], value); }
  if (!candidates.length) return result('no-op', [], []);
  const head = candidates[0]!;
  if (selection !== 'all' && head.dependency !== selection) {
    return result('blocked', [], candidates.map((operation) => operation.id), {
      code: 'PLATFORM_OPERATION_RECOVERY_PENDING',
      message: 'The first unresolved platform operation belongs to another recovery selection',
      retryable: true
    });
  }
  const limit = options.limit === undefined ? candidates.length : Math.max(1, options.limit);
  const recovered: string[] = [];
  const pending: string[] = [];
  let warnings: readonly OperationWarning[] = [];
  const selected = candidates.slice(0, limit);
  for (const operation of selected) {
    {
      try {
        recordPlatformOperation({
          taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind,
          target: operation.target, expectedDigest: operation.expectedDigest,
          dependency: operation.dependency, state: 'pending',
          ...(operation.issueMetadata ? { issueMetadata: operation.issueMetadata } : {}),
          ...(operation.issueCreate ? { issueCreate: operation.issueCreate } : {}),
          ...(operation.pullRequest ? { pullRequest: operation.pullRequest } : {}),
          ...(operation.pullRequestSummary ? { pullRequestSummary: operation.pullRequestSummary } : {}),
          ...(operation.pullRequestReview ? { pullRequestReview: operation.pullRequestReview } : {})
        });
      } catch (error) {
        const value = error as { code?: string; message?: string };
        return result('blocked', recovered, [...pending, operation.id], {
          code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED',
          message: value.message || String(error), retryable: true
        });
      }
    }
    let targetOperation = operation;
    if (operation.kind === 'issue-metadata') {
      const current = currentIssueMetadataOperation(resolved.taskId, resolved.taskMdPath, resolved.repoRoot, operation);
      if (!current) {
        pending.push(operation.id);
        return result('blocked', recovered, pending, { code: 'PLATFORM_OPERATION_TARGET_UNAVAILABLE', message: 'Current Issue metadata target cannot be reconstructed safely', retryable: true });
      }
      if (current.target !== operation.target) {
        return result('blocked', recovered, [...pending, operation.id], { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Bound Issue identity differs from the journal target', retryable: false });
      }
      if (current.id !== operation.id) {
        try {
          recordPlatformOperation({ taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind, target: operation.target,
            expectedDigest: current.expectedDigest, issueMetadata: current.issueMetadata, dependency: operation.dependency,
            state: 'queued', replaceOperationId: operation.id });
          targetOperation = { ...operation, expectedDigest: current.expectedDigest, issueMetadata: current.issueMetadata, id: current.id };
        } catch (error) {
          const value = error as { code?: string; message?: string };
          return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
        }
      }
    }
    if (operation.kind === 'task-comment' || operation.kind === 'artifact-comment'
      || operation.kind === 'summary-comment' || operation.kind === 'cancel-comment') {
      const commentOptions = operation.kind === 'task-comment'
        ? { kind: 'task' as const, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency }
          : operation.kind === 'artifact-comment'
            ? { kind: 'artifact' as const, artifact: operation.target, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency }
            : operation.kind === 'summary-comment' ? (() => {
              try {
                const summary = summaryPayload(resolved.taskDir, resolved.taskId);
                return summary ? { kind: 'summary' as const, body: summary.body, agent: options.agent, cwd: resolved.repoRoot, summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency } : null;
              } catch { return null; }
            })() : (() => {
              try {
                const body = cancellationPayload(resolved.taskDir, resolved.taskId);
                return body ? { kind: 'cancel' as const, body, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency } : null;
              } catch { return null; }
            })();
      const current = commentOptions ? inspectPlatformCommentOperation(resolved.taskId, commentOptions) : null;
      if (!current) {
        pending.push(operation.id);
        return result('blocked', recovered, pending, { code: 'PLATFORM_OPERATION_TARGET_UNAVAILABLE', message: 'Current comment target cannot be reconstructed safely', retryable: true });
      }
      if (current.id !== operation.id) {
        try {
          recordPlatformOperation({ taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind, target: operation.target,
            expectedDigest: current.expectedDigest, dependency: operation.dependency, state: 'queued', replaceOperationId: operation.id });
          targetOperation = { ...operation, expectedDigest: current.expectedDigest, id: current.id };
        } catch (error) {
          const value = error as { code?: string; message?: string };
          return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
        }
      }
    }
    let remote: PlatformResult & { warnings?: readonly OperationWarning[] };
    try {
      remote = operation.kind === 'issue-create'
        ? await verifyIssueCreate(resolved.taskId, operation, resolved.repoRoot)
        : operation.kind === 'pull-request-summary'
        ? await replayPullRequestSummary(resolved.taskId, targetOperation, { agent: options.agent, cwd: resolved.repoRoot, client: options.client })
        : operation.kind === 'pull-request-review'
        ? await replayPullRequestReview(operation, options.agent, resolved.repoRoot, options.client)
        : operation.kind === 'issue-metadata'
        ? await replayIssueMetadata(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
        : operation.kind === 'pull-request'
          ? await replayPullRequest(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
          : await replayComment(resolved.taskId, resolved.taskDir, targetOperation, options.agent, resolved.repoRoot, options.client);
    }
    catch (error) {
      const value = error as { code?: string; message?: string };
      remote = platformResult('blocked', { error: { code: value.code || 'PLATFORM_OPERATION_RECOVERY_FAILED', message: value.message || String(error), retryable: true } });
    }
    const succeeded = (remote.status === 'applied' || remote.status === 'no-op') && !remote.error;
    const latestOperation = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot).operations.find((item) => item.id === operation.id);
    try {
      recordPlatformOperation({
        taskRef: resolved.taskId,
        cwd: resolved.repoRoot,
        kind: operation.kind,
        target: operation.target,
        expectedDigest: targetOperation.expectedDigest,
        ...(targetOperation.issueMetadata ? { issueMetadata: targetOperation.issueMetadata } : {}),
        ...(operation.issueCreate ? { issueCreate: operation.issueCreate } : {}),
        ...(operation.pullRequest ? { pullRequest: operation.pullRequest } : {}),
        ...(operation.pullRequestSummary ? { pullRequestSummary: operation.pullRequestSummary } : {}),
        ...(operation.pullRequestReview ? { pullRequestReview: operation.pullRequestReview } : {}),
        dependency: operation.dependency,
        state: succeeded ? 'succeeded' : 'unknown',
        lastCode: remote.error?.code ?? remote.operations.find((item) => item.status === 'skipped' && item.reasonCode === 'PUSH_REQUIRED')?.reasonCode ?? (succeeded ? null : latestOperation?.lastCode) ?? null
      });
    } catch (error) {
      const value = error as { code?: string; message?: string };
      return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
    }
    if (!succeeded) {
      pending.push(targetOperation.id);
      return result(remote.status === 'failed' ? 'failed' : 'blocked', recovered, pending, remote.error ?? { code: 'PLATFORM_OPERATION_RECOVERY_UNKNOWN', message: 'Platform operation outcome remains unknown', retryable: true });
    }
      warnings = mergeOperationWarnings(warnings, remote.warnings ?? []);
      recovered.push(targetOperation.id);
  }
  const remaining = candidates.slice(limit).map((operation) => operation.id);
  pending.push(...remaining);
  return result(pending.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, pending, pending.length ? { code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'Platform operations remain pending after the recovery budget', retryable: true } : null, warnings);
}

async function recoverPlatformOperations(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false });
  let initial;
  try { initial = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return result('failed', [], [], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: false });
  }
  let first;
  try { first = recoveryCandidates(initial, options); }
  catch (error) { const value = error as { code: string; message: string }; return result('blocked', [], [], value); }
  if (!first.length) return result('no-op', [], []);
  const operationLimit = options.limit === undefined ? first.length : Math.max(1, options.limit);
  const attemptLimit = options.attempts ?? DEFAULT_RECOVERY_ATTEMPTS;
  if (!Number.isSafeInteger(attemptLimit) || attemptLimit <= 0) {
    return result('failed', [], [], { code: 'PLATFORM_OPERATION_RECOVERY_PAYLOAD_INVALID', message: 'Recovery attempts must be a positive safe integer', retryable: false });
  }
  const recovered: string[] = [];
  let warnings: readonly OperationWarning[] = [];

  for (let operationIndex = 0; operationIndex < operationLimit; operationIndex += 1) {
    let latest;
    try { latest = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot); }
    catch (error) {
      const value = error as { code?: string; message?: string };
      return result('failed', recovered, [], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: false }, warnings);
    }
    let candidates;
    try { candidates = recoveryCandidates(latest, options); }
    catch (error) { const value = error as { code: string; message: string }; return result('blocked', recovered, [], value, warnings); }
    const head = candidates[0];
    if (!head) break;
    if (selection !== 'all' && head.dependency !== selection) {
      const pending = candidates.map((operation) => operation.id);
      return result('blocked', recovered, pending, {
        code: 'PLATFORM_OPERATION_RECOVERY_PENDING',
        message: 'The first unresolved platform operation belongs to another recovery selection',
        retryable: true
      }, warnings);
    }
    let last: RecoveryResult | null = null;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      last = await recoverPlatformOperationsOnce(taskRef, selection, { ...options, limit: 1 });
      recovered.push(...last.recovered.filter((id) => !recovered.includes(id)));
      warnings = mergeOperationWarnings(warnings, last.warnings ?? []);
      if (last.recovered.length > 0 || last.status === 'applied' || last.status === 'no-op') break;
    }
    if (!last || (last.recovered.length === 0 && last.status !== 'applied' && last.status !== 'no-op')) {
      let current;
      try { current = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot); }
      catch { return result('blocked', recovered, [head.id], last?.error ?? null, warnings); }
      let pending: string[];
      try { pending = recoveryCandidates(current, options).map((operation) => operation.id); }
      catch (error) { const value = error as { code: string; message: string }; return result('blocked', recovered, [], value, warnings); }
      return result(last?.status === 'failed' ? 'failed' : 'blocked', recovered, pending, last?.error ?? {
        code: 'PLATFORM_OPERATION_RECOVERY_PENDING',
        message: 'The first queued platform operation remains unresolved after this recovery run',
        retryable: true
      }, warnings);
    }
  }
  let remaining: string[];
  try { remaining = recoveryCandidates(readPlatformOperationJournal(resolved.taskId, resolved.repoRoot), options).map((operation) => operation.id); }
  catch (error) { const value = error as { code?: string; message?: string }; return result('blocked', recovered, [], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || 'Unable to read platform operations' }, warnings); }
  const output = result(remaining.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, remaining,
    remaining.length ? { code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'Platform operations remain queued after this recovery run', retryable: true } : null, warnings);
  const degraded = readPlatformOperationJournal(resolved.taskId, resolved.repoRoot).operations.filter((item) => recovered.includes(item.id) && item.lastCode === 'PUSH_REQUIRED').map((item) => ({ id: item.id, reasonCode: item.lastCode! }));
  return degraded.length ? { ...output, degraded } : output;
}

export { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverPlatformOperations };
export type { RecoveryOptions, RecoveryResult };
