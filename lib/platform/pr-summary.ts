import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { enumerateArtifacts } from '../task/artifacts.ts';
import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { renderHumanOverrideAudit } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { resolvePlatformProviderContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { listRemoteComments, normalizeCommentContent, writeComment } from './issue-comments.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import type { OperationWarning } from '../task/operation-outcome.ts';
import { readPrDeliveryFact } from '../task/pr-delivery-fact.ts';
import { providerError, providerOperationContext, providerStatus, unsupportedProviderOperation } from './provider-bridge.ts';

type SummaryComment = { id: number | string; body: string };
type SummaryContextResult = PlatformResult & {
  task: { id: string | null; prNumber: number | null };
  artifacts: Array<{ family: string; name: string; path: string }>;
};
type PullRequestSummaryResult = PlatformResult & {
  result: 'pr_created_with_warnings' | 'pr_reused_with_warnings' | 'no_op_with_warnings' | null;
  warnings: readonly OperationWarning[];
};
type PullRequestPrimaryResult = 'pr_created' | 'pr_reused' | 'no_op';

function warningResultForPrimary(primaryResult: PullRequestPrimaryResult): NonNullable<PullRequestSummaryResult['result']> {
  if (primaryResult === 'pr_created') return 'pr_created_with_warnings';
  if (primaryResult === 'pr_reused') return 'pr_reused_with_warnings';
  return 'no_op_with_warnings';
}

function summaryMarker(taskId: string): string {
  return `<!-- sync-pr:${taskId}:summary -->`;
}

function buildPullRequestSummary(taskId: string, body: string, headSha: string, humanOverrideAudit = ''): string {
  const sections = [body.replace(/\s+$/, ''), humanOverrideAudit.trim()].filter(Boolean).join('\n\n');
  return normalizeCommentContent(`${summaryMarker(taskId)}\n<!-- last-commit: ${headSha} -->\n\n${sections}\n`);
}

function reconcileSummaryComment(comments: SummaryComment[], taskId: string, desired: string):
  { action: 'create' | 'update' | 'no-op' | 'conflict'; commentId: number | string | null } {
  const marker = summaryMarker(taskId);
  const matches = comments.filter((comment) => comment.body.includes(marker));
  if (matches.length > 1) return { action: 'conflict', commentId: null };
  if (matches.length === 0) return { action: 'create', commentId: null };
  return normalizeCommentContent(matches[0]!.body) === normalizeCommentContent(desired)
    ? { action: 'no-op', commentId: matches[0]!.id }
    : { action: 'update', commentId: matches[0]!.id };
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
  return [...byFamily.values()].map(({ family, name, path }) => ({ family, name, path }));
}

function summaryContext(taskRef: string, options: { cwd?: string; client?: GitHubClient } = {}): SummaryContextResult {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ...platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }), task: { id: resolved.taskId, prNumber: null }, artifacts: [] };
  const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const fact = readPrDeliveryFact(frontmatter);
  const prNumber = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.number : null;
  return { ...platformResult('no-op'), task: { id: resolved.taskId, prNumber }, artifacts: canonicalArtifacts(resolved.taskDir) };
}

async function syncPullRequestSummary(taskRef: string, options: { agent: string; body: string; cwd?: string; client?: GitHubClient; dryRun?: boolean; primaryResult: PullRequestPrimaryResult }): Promise<PullRequestSummaryResult> {
  const warningResult = warningResultForPrimary(options.primaryResult);
  let knownPrNumber: number | null = null;
  const softenFailure = (output: PlatformResult): PullRequestSummaryResult => {
    const prNumber = output.resource.kind === 'pull-request' && output.resource.number
      ? output.resource.number
      : knownPrNumber;
    const warning = output.error && prNumber
      && output.error.code !== 'PR_NOT_LINKED'
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
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return softenFailure(platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }));
  const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const fact = readPrDeliveryFact(frontmatter);
  if (fact.status === 'invalid') return softenFailure(platformResult('failed', { error: { code: 'PR_DELIVERY_FACT_INVALID', message: fact.error.message, retryable: false } }));
  const prNumber = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.number : null;
  if (!prNumber) return softenFailure(platformResult('failed', { error: { code: fact.status === 'missing' ? 'PR_DELIVERY_FACT_MISSING' : 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false } }));
  knownPrNumber = prNumber;
  const client = options.client || createGitHubClient();
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return softenFailure(context);
  let headSha: string;
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolved.repoRoot, encoding: 'utf8' }).trim();
  } catch (error) {
    return softenFailure(platformResult('failed', { platform: context.platform, capabilities: context.capabilities, error: { code: 'GIT_HEAD_UNRESOLVED', message: error instanceof Error ? error.message : String(error), retryable: false } }));
  }
  const desired = buildPullRequestSummary(
    resolved.taskId,
    options.body,
    headSha,
    renderHumanOverrideAudit(fs.readFileSync(resolved.taskMdPath, 'utf8'))
  );
  const listed = loaded.ok
    ? (loaded.value.provider.comments?.list
      ? await loaded.value.provider.comments.list({ context: providerOperationContext(loaded.value), parent: { number: prNumber } }).then((response) => response.ok
        ? { ok: true as const, value: response.value.map((comment) => ({ id: loaded.value.providerType === 'github' && /^\d+$/.test(comment.id) ? Number(comment.id) : comment.id, body: comment.body })) }
        : response)
      : unsupportedProviderOperation(loaded.value.provider, 'comments.list'))
    : listRemoteComments(client, context.platform.repository, prNumber, resolved.repoRoot);
  if (!listed.ok) return softenFailure(platformResult(listed.error.retryable ? 'blocked' : 'failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: listed.error }));
  const reconciliation = reconcileSummaryComment(listed.value, resolved.taskId, desired);
  if (reconciliation.action === 'conflict') return softenFailure(platformResult('failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: { code: 'PR_SUMMARY_MARKER_AMBIGUOUS', message: 'Multiple PR comments contain the summary marker', retryable: false } }));
  if (reconciliation.action === 'no-op') return softenFailure(platformResult('no-op', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: [reconciliation.commentId!], parts: 1 }, error: null }));
  if (options.dryRun) return softenFailure(platformResult('planned', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, operations: [{ name: `summary:${reconciliation.action}`, status: 'planned', reasonCode: null }], error: null }));
  const written = loaded.ok
    ? (loaded.value.provider.comments?.write
      ? await loaded.value.provider.comments.write({
        context: providerOperationContext(loaded.value),
        parent: { number: prNumber },
        body: desired,
        ...(reconciliation.commentId !== null ? { existingComment: { id: String(reconciliation.commentId) } } : {}),
        mutation: { idempotencyKey: `pr-summary:${resolved.taskId}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'comments.write'))
    : writeComment(client, context.platform.repository, prNumber, resolved.repoRoot, desired, typeof reconciliation.commentId === 'number' ? reconciliation.commentId : undefined);
  if (!written.ok) return softenFailure(platformResult(written.error.retryable ? 'blocked' : 'failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: written.error }));
  const id = loaded.ok
    ? (loaded.value.providerType === 'github' && /^\d+$/.test((written.value as { remoteId: string }).remoteId)
      ? Number((written.value as { remoteId: string }).remoteId)
      : (written.value as { remoteId: string }).remoteId)
    : Number((written.value as { id?: number }).id || reconciliation.commentId);
  return softenFailure(platformResult('applied', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: id ? [id] : [], parts: 1 }, operations: [{ name: `summary:${reconciliation.action}`, status: 'applied', reasonCode: null }], error: null }));
}

export { buildPullRequestSummary, reconcileSummaryComment, summaryContext, summaryMarker, syncPullRequestSummary };
export type { PullRequestSummaryResult, SummaryContextResult };
export { warningResultForPrimary };
