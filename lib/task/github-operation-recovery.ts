import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { inspectGithubCommentOperation, syncPlatformComment } from '../platform/issue-comments.ts';
import { inspectPlatformIssue, syncPlatformIssue } from '../platform/issues.ts';
import { bindPlatformPullRequest, recoverCreatedPullRequest, syncPlatformPullRequest } from '../platform/pull-requests.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
import { taskIssueIdentity } from '../platform/task-identities.ts';
import { parseResourceIdentity, resourceIdentityEquals } from '../platform/resource-identity.ts';
import { operationId } from './github-operation-journal.ts';
import { canonicalizeSummaryBody } from '../platform/comment-safety.ts';
import { platformResult } from '../platform/types.ts';
import type { PlatformResult } from '../platform/types.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { readGithubOperationJournal, recordGithubOperation } from './github-operation-journal.ts';

type RecoveryOptions = Readonly<{ agent: string; cwd?: string; limit?: number }>;
type RecoveryResult = Readonly<{
  status: 'applied' | 'no-op' | 'blocked' | 'failed';
  changed: boolean;
  recovered: readonly string[];
  pending: readonly string[];
  error: { code: string; message: string; retryable: boolean } | null;
}>;

function result(status: RecoveryResult['status'], recovered: string[], pending: string[], error: RecoveryResult['error'] = null): RecoveryResult {
  return { status, changed: recovered.length > 0, recovered, pending, error };
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

async function replayComment(taskId: string, taskDir: string, operation: ReturnType<typeof readGithubOperationJournal>['operations'][number], agent: string, cwd: string): Promise<PlatformResult> {
  if (operation.kind === 'task-comment') {
    return syncPlatformComment(taskId, { kind: 'task', agent, cwd, dependency: operation.dependency });
  }
  if (operation.kind === 'artifact-comment') {
    return syncPlatformComment(taskId, { kind: 'artifact', artifact: operation.target, agent, cwd, dependency: operation.dependency });
  }
  if (operation.kind === 'summary-comment') {
    const summary = summaryPayload(taskDir, taskId);
    if (!summary) return platformResult('failed', { error: { code: 'SUMMARY_STAGING_MISSING', message: 'delivery summary staging record is unavailable', retryable: false } });
    return syncPlatformComment(taskId, {
      kind: 'summary', body: summary.body, agent, cwd,
      summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency
    });
  }
  return platformResult('failed', { error: { code: 'GITHUB_OPERATION_UNSUPPORTED', message: `operation kind '${operation.kind}' has no registered recovery handler`, retryable: false } });
}

function currentIssueMetadataOperation(taskId: string, taskMdPath: string, operation: ReturnType<typeof readGithubOperationJournal>['operations'][number]) {
  if (operation.kind !== 'issue-metadata' || !operation.issueMetadata) return null;
  const content = fs.readFileSync(taskMdPath, 'utf8');
  const identity = taskIssueIdentity(parseTaskFrontmatter(content));
  if (!identity) return null;
  const target = JSON.stringify(identity);
  const expectedDigest = createHash('sha256').update(JSON.stringify({
    ...operation.issueMetadata,
    task: taskId,
    taskContent: createHash('sha256').update(content).digest('hex')
  })).digest('hex');
  return { kind: 'issue-metadata' as const, target, expectedDigest, id: operationId({ kind: 'issue-metadata', target, expectedDigest }) };
}

async function replayIssueMetadata(taskId: string, operation: ReturnType<typeof readGithubOperationJournal>['operations'][number], agent: string, cwd: string): Promise<PlatformResult> {
  if (!operation.issueMetadata) return platformResult('failed', { error: { code: 'GITHUB_OPERATION_PAYLOAD_INVALID', message: 'Issue metadata recovery parameters are missing', retryable: false } });
  let expectedIdentity;
  try { expectedIdentity = parseResourceIdentity(JSON.parse(operation.target), 'journal Issue identity'); }
  catch { return platformResult('failed', { error: { code: 'GITHUB_OPERATION_PAYLOAD_INVALID', message: 'Journal Issue identity is invalid', retryable: false } }); }
  const before = await inspectPlatformIssue(taskId, { cwd });
  if (before.status !== 'no-op' || before.error || !before.issue
    || !resourceIdentityEquals(before.issue.identity, expectedIdentity)) {
    return platformResult('blocked', { error: before.error ?? { code: 'GITHUB_OPERATION_IDENTITY_MISMATCH', message: 'Bound Issue identity differs from the journal target', retryable: false } });
  }
  const sync = await syncPlatformIssue(taskId, { ...operation.issueMetadata, agent, cwd, dependency: operation.dependency });
  if ((sync.status !== 'applied' && sync.status !== 'no-op') || sync.error) return sync;
  const after = await inspectPlatformIssue(taskId, { cwd });
  if (after.status !== 'no-op' || after.error || !after.issue
    || !resourceIdentityEquals(after.issue.identity, expectedIdentity)) {
    return platformResult('blocked', { error: after.error ?? { code: 'GITHUB_OPERATION_IDENTITY_MISMATCH', message: 'Issue identity changed during metadata recovery', retryable: false } });
  }
  return platformResult('no-op', { changed: sync.changed || after.changed });
}

async function replayPullRequest(taskId: string, operation: ReturnType<typeof readGithubOperationJournal>['operations'][number], agent: string, cwd: string): Promise<PlatformResult> {
  const intent = operation.pullRequest;
  if (!intent) return platformResult('failed', { error: { code: 'GITHUB_OPERATION_PAYLOAD_INVALID', message: 'Pull-request recovery parameters are missing', retryable: false } });
  if (intent.action === 'bind') {
    if (!intent.prToken) return platformResult('failed', { error: { code: 'GITHUB_OPERATION_PAYLOAD_INVALID', message: 'Pull-request bind identity is missing', retryable: false } });
    return bindPlatformPullRequest(taskId, { agent, cwd, pr: intent.prToken });
  }
  if (intent.action === 'sync') {
    const synced = await syncPlatformPullRequest(taskId, {
      agent, cwd, metadata: intent.metadata === true, closingIssue: intent.closingIssue === true, primaryResult: 'no_op'
    });
    if (synced.warnings.length > 0 || synced.result?.endsWith('_with_warnings')) {
      return platformResult('blocked', { error: { code: 'GITHUB_OPERATION_PR_SYNC_UNCONFIRMED', message: 'Pull-request metadata sync remains degraded', retryable: true } });
    }
    return synced;
  }
  return recoverCreatedPullRequest(taskId, { agent, cwd, base: intent.baseRef || '', head: intent.headRef || '' });
}

async function recoverGithubOperations(
  taskRef: string,
  selection: 'required' | 'deferred' | 'all',
  options: RecoveryOptions
): Promise<RecoveryResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', [], [], { code: resolved.code, message: resolved.message, retryable: false });
  let journal;
  try { journal = readGithubOperationJournal(resolved.taskId, resolved.repoRoot); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return result('failed', [], [], { code: value.code || 'GITHUB_OPERATION_JOURNAL_INVALID', message: value.message || String(error), retryable: false });
  }
  const candidates = journal.operations.filter((operation) => operation.state === 'pending' || operation.state === 'unknown')
    .filter((operation) => selection === 'all' || operation.dependency === selection)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  if (!candidates.length) return result('no-op', [], []);
  const limit = Math.max(1, Math.min(20, options.limit ?? 3));
  const recovered: string[] = [];
  const pending: string[] = [];
  for (const operation of candidates.slice(0, limit)) {
    if (operation.attempts >= operation.maxAttempts) {
      pending.push(operation.id);
      continue;
    }
    let targetOperation = operation;
    if (operation.kind === 'issue-metadata') {
      const current = currentIssueMetadataOperation(resolved.taskId, resolved.taskMdPath, operation);
      if (!current) {
        pending.push(operation.id);
        return result('blocked', recovered, pending, { code: 'GITHUB_OPERATION_TARGET_UNAVAILABLE', message: 'Current Issue metadata target cannot be reconstructed safely', retryable: true });
      }
      if (current.target !== operation.target) {
        return result('blocked', recovered, [...pending, operation.id], { code: 'GITHUB_OPERATION_IDENTITY_MISMATCH', message: 'Bound Issue identity differs from the journal target', retryable: false });
      }
      if (current.id !== operation.id) {
        try {
          recordGithubOperation({ taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind, target: operation.target,
            expectedDigest: operation.expectedDigest, issueMetadata: operation.issueMetadata, dependency: operation.dependency,
            state: 'failed', lastCode: 'GITHUB_OPERATION_SUPERSEDED' });
          targetOperation = { ...operation, expectedDigest: current.expectedDigest, id: current.id };
        } catch (error) {
          const value = error as { code?: string; message?: string };
          return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'GITHUB_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
        }
      }
    }
    if (operation.kind === 'task-comment' || operation.kind === 'artifact-comment' || operation.kind === 'summary-comment') {
      const commentOptions = operation.kind === 'task-comment'
        ? { kind: 'task' as const, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency }
        : operation.kind === 'artifact-comment'
          ? { kind: 'artifact' as const, artifact: operation.target, agent: options.agent, cwd: resolved.repoRoot, dependency: operation.dependency }
          : (() => {
            const summary = summaryPayload(resolved.taskDir, resolved.taskId);
            return summary ? { kind: 'summary' as const, body: summary.body, agent: options.agent, cwd: resolved.repoRoot, summaryAuthorization: { sha256: summary.sha256 }, dependency: operation.dependency } : null;
          })();
      const current = commentOptions ? inspectGithubCommentOperation(resolved.taskId, commentOptions) : null;
      if (!current) {
        pending.push(operation.id);
        return result('blocked', recovered, pending, { code: 'GITHUB_OPERATION_TARGET_UNAVAILABLE', message: 'Current comment target cannot be reconstructed safely', retryable: true });
      }
      if (current.id !== operation.id) {
        try {
          recordGithubOperation({ taskRef: resolved.taskId, cwd: resolved.repoRoot, kind: operation.kind, target: operation.target,
            expectedDigest: operation.expectedDigest, dependency: operation.dependency, state: 'failed', lastCode: 'GITHUB_OPERATION_SUPERSEDED' });
          targetOperation = { ...operation, expectedDigest: current.expectedDigest, id: current.id };
        } catch (error) {
          const value = error as { code?: string; message?: string };
          return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'GITHUB_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
        }
      }
    }
    let remote: PlatformResult;
    try {
      remote = operation.kind === 'issue-metadata'
        ? await replayIssueMetadata(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
        : operation.kind === 'pull-request'
          ? await replayPullRequest(resolved.taskId, targetOperation, options.agent, resolved.repoRoot)
          : await replayComment(resolved.taskId, resolved.taskDir, operation, options.agent, resolved.repoRoot);
    }
    catch (error) {
      const value = error as { code?: string; message?: string };
      remote = platformResult('blocked', { error: { code: value.code || 'GITHUB_OPERATION_RECOVERY_FAILED', message: value.message || String(error), retryable: true } });
    }
    const succeeded = (remote.status === 'applied' || remote.status === 'no-op') && !remote.error;
    try {
      recordGithubOperation({
        taskRef: resolved.taskId,
        cwd: resolved.repoRoot,
        kind: operation.kind,
        target: operation.target,
        expectedDigest: targetOperation.expectedDigest,
        ...(operation.issueMetadata ? { issueMetadata: operation.issueMetadata } : {}),
        ...(operation.pullRequest ? { pullRequest: operation.pullRequest } : {}),
        dependency: operation.dependency,
        state: succeeded ? 'succeeded' : remote.status === 'failed' && remote.error?.retryable === false ? 'failed' : 'unknown',
        lastCode: remote.error?.code ?? null
      });
    } catch (error) {
      const value = error as { code?: string; message?: string };
      return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'GITHUB_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
    }
    if (!succeeded) {
      pending.push(targetOperation.id);
      return result(remote.status === 'failed' ? 'failed' : 'blocked', recovered, pending, remote.error ?? { code: 'GITHUB_OPERATION_RECOVERY_UNKNOWN', message: 'GitHub operation outcome remains unknown', retryable: true });
    }
      recovered.push(targetOperation.id);
  }
  const remaining = candidates.slice(limit).map((operation) => operation.id);
  pending.push(...remaining);
  return result(pending.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, pending, pending.length ? { code: 'GITHUB_OPERATION_RECOVERY_PENDING', message: 'GitHub operations remain pending after the recovery budget', retryable: true } : null);
}

export { recoverGithubOperations };
export type { RecoveryOptions, RecoveryResult };
