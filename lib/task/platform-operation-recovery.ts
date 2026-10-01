import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { inspectPlatformCommentOperation, normalizeCommentContent, syncPlatformComment } from '../platform/issue-comments.ts';
import { inspectPlatformIssue, syncPlatformIssue } from '../platform/issues.ts';
import { resolvePlatformProviderContext } from '../platform/context.ts';
import { providerOperationContext, providerError, unsupportedProviderOperation } from '../platform/provider-bridge.ts';
import { inLabelMappingDigest } from '../platform/in-label-sync.ts';
import { bindPlatformPullRequest, inspectPlatformPullRequest, recoverCreatedPullRequest, syncPlatformPullRequest } from '../platform/pull-requests.ts';
import { syncPullRequestSummary } from '../platform/pr-summary.ts';
import { publishPrReview, readReviewBodyFile } from '../platform/pr-review.ts';
import type { PlatformClient } from '../platform/context.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
import { taskIssueIdentity } from '../platform/task-identities.ts';
import { parseResourceIdentity, resourceIdentityEquals } from '../platform/resource-identity.ts';
import { operationId } from './platform-operation-journal.ts';
import { canonicalizeSummaryBody } from '../platform/comment-safety.ts';
import { platformResult } from '../platform/types.ts';
import type { PlatformResult } from '../platform/types.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { readPlatformOperationJournal, recordPlatformOperation, resolveFailedPlatformOperation } from './platform-operation-journal.ts';

type RecoveryOptions = Readonly<{ agent: string; client?: PlatformClient; cwd?: string; limit?: number; excludeId?: string; operationId?: string }>;
type RecoveryResult = Readonly<{
  status: 'applied' | 'no-op' | 'blocked' | 'failed';
  changed: boolean;
  recovered: readonly string[];
  pending: readonly string[];
  error: { code: string; message: string; retryable: boolean } | null;
}>;

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

function result(status: RecoveryResult['status'], recovered: string[], pending: string[], error: RecoveryResult['error'] = null): RecoveryResult {
  return { status, changed: recovered.length > 0, recovered, pending, error };
}

function hasUnresolvedRetry(operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number]): boolean {
  return operation.resolutions?.at(-1)?.action === 'retry'
    && operation.state !== 'succeeded'
    && !(operation.state === 'failed' && operation.lastCode === 'PLATFORM_OPERATION_SUPERSEDED');
}

function summaryPayload(taskDir: string, taskId: string): { body: string; sha256: string } | null {
  const file = path.join(taskDir, '.delivery-summary.json');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { taskId?: unknown; body?: unknown; sha256?: unknown };
  const canonical = typeof data.body === 'string' ? canonicalizeSummaryBody(data.body) : null;
  if (data.taskId !== taskId || typeof data.body !== 'string' || typeof data.sha256 !== 'string'
    || !canonical?.ok || canonical.value !== data.body
    || createHash('sha256').update(data.body).digest('hex') !== data.sha256) {
    throw Object.assign(new Error('delivery summary staging record is invalid'), { code: 'SUMMARY_STAGING_INVALID' });
  }
  return { body: data.body, sha256: data.sha256 };
}

async function replayComment(taskId: string, taskDir: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  if (operation.kind === 'task-comment') {
    return syncPlatformComment(taskId, { kind: 'task', agent, cwd, client, dependency: operation.dependency, skipQueue: true });
  }
  if (operation.kind === 'artifact-comment') {
    return syncPlatformComment(taskId, { kind: 'artifact', artifact: operation.target, agent, cwd, client, dependency: operation.dependency, skipQueue: true });
  }
  if (operation.kind === 'summary-comment') {
    const summary = summaryPayload(taskDir, taskId);
    if (!summary) return platformResult('failed', { error: { code: 'SUMMARY_STAGING_MISSING', message: 'delivery summary staging record is unavailable', retryable: false } });
    return syncPlatformComment(taskId, {
      kind: 'summary', body: summary.body, agent, cwd,
      summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency, client, skipQueue: true
    });
  }
  if (operation.kind === 'cancel-comment') {
    return syncPlatformComment(taskId, { kind: 'cancel', agent, cwd, client, dependency: operation.dependency, skipQueue: true });
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
  const failedOperation = sync.operations.find((item) => item.status === 'failed' || item.status === 'skipped');
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
  return platformResult('no-op', { changed: sync.changed || after.changed });
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

async function replayPullRequestSummary(taskId: string, operation: ReturnType<typeof readPlatformOperationJournal>['operations'][number], agent: string, cwd: string, client?: PlatformClient): Promise<PlatformResult> {
  let identity;
  try { identity = parseResourceIdentity(JSON.parse(operation.target), 'queued pull-request summary identity'); }
  catch { return platformResult('failed', { error: { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Queued pull-request summary identity is invalid', retryable: false } }); }
  const resolved = await resolvePlatformProviderContext({ cwd, client });
  if (!resolved.ok) return resolved.context;
  const listed = resolved.value.provider.comments?.list
    ? await resolved.value.provider.comments.list({ context: providerOperationContext(resolved.value), parent: identity })
    : unsupportedProviderOperation(resolved.value.provider, 'comments.list');
  if (!listed.ok) return platformResult(listed.error.retryable ? 'blocked' : 'failed', { error: providerError(listed.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') });
  const marker = `<!-- sync-pr:${taskId}:summary -->`;
  const summaries = listed.value.filter((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === marker);
  if (summaries.length > 1) return platformResult('blocked', { error: {
    code: 'PR_SUMMARY_MARKER_AMBIGUOUS', message: 'Multiple pull-request comments contain the queued summary marker', retryable: false
  } });
  if (summaries.length === 1 && createHash('sha256').update(normalizeCommentContent(summaries[0]!.body)).digest('hex') === operation.expectedDigest) {
    return platformResult('no-op');
  }
  if (!operation.pullRequestSummary) return platformResult('blocked', { error: {
    code: 'PLATFORM_OPERATION_PAYLOAD_INVALID', message: 'Pull-request summary recovery content is missing', retryable: false
  } });
  const bound = await inspectPlatformPullRequest(taskId, { cwd, client });
  if (!bound.pullRequest || !resourceIdentityEquals(bound.pullRequest.identity, identity)) return platformResult('blocked', { error: bound.error ?? {
    code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Bound pull request differs from the queued summary target', retryable: false
  } });
  const replayed = await syncPullRequestSummary(taskId, {
    agent,
    cwd,
    client,
    body: operation.pullRequestSummary.body,
    changeReportFile: operation.pullRequestSummary.changeReportFile,
    primaryResult: 'no_op',
    strict: true,
    skipQueue: true,
    lockAlreadyHeld: true
  });
  if ((replayed.status === 'applied' || replayed.status === 'no-op') && !replayed.error && replayed.warnings.length === 0) {
    return platformResult(replayed.status, { changed: replayed.changed });
  }
  return platformResult('blocked', { error: replayed.error ?? {
    code: 'PR_SUMMARY_RECOVERY_UNCONFIRMED', message: 'Pull-request summary replay did not confirm the requested remote state', retryable: true
  } });
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

async function recoverPlatformOperations(
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
  const recoverable = journal.operations.filter((operation) => operation.id !== options.excludeId
    && (operation.state === 'queued' || operation.state === 'pending' || operation.state === 'unknown'
      || (operation.state === 'failed' && operation.lastCode !== 'PLATFORM_OPERATION_SUPERSEDED')));
  const retryBarriers = recoverable.filter(hasUnresolvedRetry);
  const scoped = recoverable.filter((operation) => (selection === 'all' || operation.dependency === selection)
    && (options.operationId === undefined || operation.id === options.operationId));
  if (options.operationId === undefined && selection !== 'all'
    && retryBarriers.some((operation) => operation.dependency !== selection)
    && scoped.some((operation) => !hasUnresolvedRetry(operation))) {
    const pending = [...retryBarriers.map((operation) => operation.id), ...scoped.map((operation) => operation.id)];
    return result('blocked', [], [...new Set(pending)], {
      code: 'PLATFORM_OPERATION_RETRY_PENDING',
      message: 'A persisted retry remains unresolved; later operations stay queued until it is confirmed',
      retryable: true
    });
  }
  const retryOrder = new Map(retryBarriers.map((operation, index) => [operation.id, index]));
  const candidates = scoped.sort((left, right) => {
    const leftRetry = retryOrder.get(left.id);
    const rightRetry = retryOrder.get(right.id);
    if (leftRetry !== undefined || rightRetry !== undefined) {
      if (leftRetry === undefined) return 1;
      if (rightRetry === undefined) return -1;
      return leftRetry - rightRetry;
    }
    return left.updatedAt.localeCompare(right.updatedAt);
  });
  if (!candidates.length) return result('no-op', [], []);
  const limit = options.limit === undefined ? candidates.length : Math.max(1, options.limit);
  const recovered: string[] = [];
  const pending: string[] = [];
  const selected = candidates.slice(0, limit);
  for (const [index, operation] of selected.entries()) {
    if (operation.state === 'failed') {
      pending.push(operation.id);
      return result('blocked', recovered, pending, {
        code: operation.lastCode || 'PLATFORM_OPERATION_FAILED',
        message: 'A previous platform operation failed permanently; later writes remain queued',
        retryable: false
      });
    }
    if (operation.attempts >= operation.maxAttempts) {
      pending.push(operation.id, ...selected.slice(index + 1).map((next) => next.id));
      pending.push(...candidates.slice(limit).map((next) => next.id));
      return result('blocked', recovered, pending, {
        code: operation.lastCode || 'PLATFORM_OPERATION_RETRY_LIMIT_REACHED',
        message: 'A previous platform operation exhausted its recovery attempts; later writes remain queued',
        retryable: false
      });
    }
    if (operation.kind !== 'issue-create') {
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
            expectedDigest: operation.expectedDigest, issueMetadata: operation.issueMetadata, dependency: operation.dependency,
            state: 'failed', lastCode: 'PLATFORM_OPERATION_SUPERSEDED' });
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
            const summary = summaryPayload(resolved.taskDir, resolved.taskId);
            return summary ? { kind: 'summary' as const, body: summary.body, agent: options.agent, cwd: resolved.repoRoot, summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency } : null;
          })() : { kind: 'cancel' as const, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency };
      const current = commentOptions ? inspectPlatformCommentOperation(resolved.taskId, commentOptions) : null;
      if (!current) {
        pending.push(operation.id);
        return result('blocked', recovered, pending, { code: 'PLATFORM_OPERATION_TARGET_UNAVAILABLE', message: 'Current comment target cannot be reconstructed safely', retryable: true });
      }
      if (current.id !== operation.id) {
        try {
          recordPlatformOperation({ taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind, target: operation.target,
            expectedDigest: operation.expectedDigest, dependency: operation.dependency, state: 'failed', lastCode: 'PLATFORM_OPERATION_SUPERSEDED' });
          targetOperation = { ...operation, expectedDigest: current.expectedDigest, id: current.id };
        } catch (error) {
          const value = error as { code?: string; message?: string };
          return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
        }
      }
    }
    let remote: PlatformResult;
    try {
      remote = operation.kind === 'issue-create'
        ? await verifyIssueCreate(resolved.taskId, operation, resolved.repoRoot)
        : operation.kind === 'pull-request-summary'
        ? await replayPullRequestSummary(resolved.taskId, operation, options.agent, resolved.repoRoot, options.client)
        : operation.kind === 'pull-request-review'
        ? await replayPullRequestReview(operation, options.agent, resolved.repoRoot, options.client)
        : operation.kind === 'issue-metadata'
        ? await replayIssueMetadata(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
        : operation.kind === 'pull-request'
          ? await replayPullRequest(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
          : await replayComment(resolved.taskId, resolved.taskDir, operation, options.agent, resolved.repoRoot);
    }
    catch (error) {
      const value = error as { code?: string; message?: string };
      remote = platformResult('blocked', { error: { code: value.code || 'PLATFORM_OPERATION_RECOVERY_FAILED', message: value.message || String(error), retryable: true } });
    }
    const succeeded = (remote.status === 'applied' || remote.status === 'no-op') && !remote.error;
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
        state: succeeded ? 'succeeded' : remote.status === 'failed' && remote.error?.retryable === false ? 'failed' : 'unknown',
        lastCode: remote.error?.code ?? null
      });
    } catch (error) {
      const value = error as { code?: string; message?: string };
      return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
    }
    if (!succeeded) {
      pending.push(targetOperation.id);
      return result(remote.status === 'failed' ? 'failed' : 'blocked', recovered, pending, remote.error ?? { code: 'PLATFORM_OPERATION_RECOVERY_UNKNOWN', message: 'Platform operation outcome remains unknown', retryable: true });
    }
      recovered.push(targetOperation.id);
  }
  const remaining = candidates.slice(limit).map((operation) => operation.id);
  pending.push(...remaining);
  return result(pending.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, pending, pending.length ? { code: 'PLATFORM_OPERATION_RECOVERY_PENDING', message: 'Platform operations remain pending after the recovery budget', retryable: true } : null);
}

async function resolvePlatformOperation(
  taskRef: string,
  input: Parameters<typeof resolveFailedPlatformOperation>[0],
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false });
  let operation;
  try {
    operation = resolveFailedPlatformOperation({ ...input, taskRef: resolved.taskId, cwd: resolved.repoRoot });
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return result('blocked', [], [input.operationId], { code: value.code || 'PLATFORM_OPERATION_RESOLUTION_FAILED', message: value.message || String(error), retryable: false });
  }
  let targeted: RecoveryResult | null = null;
  if (input.action === 'retry') {
    targeted = await recoverPlatformOperations(resolved.taskId, operation.dependency, {
      ...options, operationId: operation.id
    });
    if (targeted.status !== 'applied' && targeted.status !== 'no-op') {
      return { ...targeted, changed: true };
    }
  }
  const resumed = await recoverPlatformOperations(resolved.taskId, 'all', { ...options, excludeId: operation.id });
  const recovered = [...new Set([
    operation.id,
    ...(targeted?.status === 'applied' || targeted?.status === 'no-op' ? targeted.recovered : []),
    ...resumed.recovered
  ])];
  const completed = resumed.status === 'no-op' ? 'applied' : resumed.status;
  return {
    ...resumed,
    status: completed,
    changed: true,
    recovered,
    pending: [...new Set([...(targeted?.pending ?? []), ...resumed.pending])],
    error: resumed.error ?? targeted?.error ?? null
  };
}

export { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverPlatformOperations, resolvePlatformOperation };
export type { RecoveryOptions, RecoveryResult };
