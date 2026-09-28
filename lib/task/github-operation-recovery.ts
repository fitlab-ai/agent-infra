import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { syncPlatformComment } from '../platform/issue-comments.ts';
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
    let remote: PlatformResult;
    try { remote = await replayComment(resolved.taskId, resolved.taskDir, operation, options.agent, resolved.repoRoot); }
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
        expectedDigest: operation.expectedDigest,
        dependency: operation.dependency,
        state: succeeded ? 'succeeded' : remote.status === 'failed' && remote.error?.retryable === false ? 'failed' : 'unknown',
        lastCode: remote.error?.code ?? null
      });
    } catch (error) {
      const value = error as { code?: string; message?: string };
      return result('blocked', recovered, [...pending, operation.id], { code: value.code || 'GITHUB_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || String(error), retryable: true });
    }
    if (!succeeded) {
      pending.push(operation.id);
      return result(remote.status === 'failed' ? 'failed' : 'blocked', recovered, pending, remote.error ?? { code: 'GITHUB_OPERATION_RECOVERY_UNKNOWN', message: 'GitHub operation outcome remains unknown', retryable: true });
    }
    recovered.push(operation.id);
  }
  const remaining = candidates.slice(limit).map((operation) => operation.id);
  pending.push(...remaining);
  return result(pending.length ? 'blocked' : recovered.length ? 'applied' : 'no-op', recovered, pending, pending.length ? { code: 'GITHUB_OPERATION_RECOVERY_PENDING', message: 'GitHub operations remain pending after the recovery budget', retryable: true } : null);
}

export { recoverGithubOperations };
export type { RecoveryOptions, RecoveryResult };
