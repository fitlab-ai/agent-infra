import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { enumerateArtifacts } from '../task/artifacts.ts';
import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { renderHumanOverrideAudit } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { resolvePlatformContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { listRemoteComments, normalizeCommentContent, writeComment } from './issue-comments.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';

type SummaryComment = { id: number; body: string };
type SummaryContextResult = PlatformResult & {
  task: { id: string | null; prNumber: number | null };
  artifacts: Array<{ family: string; name: string; path: string }>;
};

function summaryMarker(taskId: string): string {
  return `<!-- sync-pr:${taskId}:summary -->`;
}

function buildPullRequestSummary(taskId: string, body: string, headSha: string, humanOverrideAudit = ''): string {
  const sections = [body.replace(/\s+$/, ''), humanOverrideAudit.trim()].filter(Boolean).join('\n\n');
  return normalizeCommentContent(`${summaryMarker(taskId)}\n<!-- last-commit: ${headSha} -->\n\n${sections}\n`);
}

function reconcileSummaryComment(comments: SummaryComment[], taskId: string, desired: string):
  { action: 'create' | 'update' | 'no-op' | 'conflict'; commentId: number | null } {
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
  const frontmatter = parseTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const value = Number(frontmatter.pr_number);
  const prNumber = Number.isInteger(value) && value > 0 ? value : null;
  return { ...platformResult('no-op'), task: { id: resolved.taskId, prNumber }, artifacts: canonicalArtifacts(resolved.taskDir) };
}

function syncPullRequestSummary(taskRef: string, options: { agent: string; body: string; cwd?: string; client?: GitHubClient; dryRun?: boolean }): PlatformResult {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } });
  const frontmatter = parseTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const prNumber = Number(frontmatter.pr_number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return platformResult('failed', { error: { code: 'PR_NOT_LINKED', message: 'Task has no valid pr_number', retryable: false } });
  const client = options.client || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  if (!context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return context;
  let headSha: string;
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolved.repoRoot, encoding: 'utf8' }).trim();
  } catch (error) {
    return platformResult('failed', { platform: context.platform, capabilities: context.capabilities, error: { code: 'GIT_HEAD_UNRESOLVED', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
  const desired = buildPullRequestSummary(
    resolved.taskId,
    options.body,
    headSha,
    renderHumanOverrideAudit(fs.readFileSync(resolved.taskMdPath, 'utf8'))
  );
  const listed = listRemoteComments(client, context.platform.repository, prNumber, resolved.repoRoot);
  if (!listed.ok) return platformResult(listed.error.retryable ? 'blocked' : 'failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: listed.error });
  const reconciliation = reconcileSummaryComment(listed.value, resolved.taskId, desired);
  if (reconciliation.action === 'conflict') return platformResult('failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: { code: 'PR_SUMMARY_MARKER_AMBIGUOUS', message: 'Multiple PR comments contain the summary marker', retryable: false } });
  if (reconciliation.action === 'no-op') return platformResult('no-op', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: [reconciliation.commentId!], parts: 1 }, error: null });
  if (options.dryRun) return platformResult('planned', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, operations: [{ name: `summary:${reconciliation.action}`, status: 'planned', reasonCode: null }], error: null });
  const written = writeComment(client, context.platform.repository, prNumber, resolved.repoRoot, desired, reconciliation.commentId || undefined);
  if (!written.ok) return platformResult(written.error.retryable ? 'blocked' : 'failed', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, error: written.error });
  const id = Number(written.value.id || reconciliation.commentId);
  return platformResult('applied', { platform: context.platform, capabilities: context.capabilities, resource: { kind: 'pull-request', number: prNumber }, comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: Number.isInteger(id) ? [id] : [], parts: 1 }, operations: [{ name: `summary:${reconciliation.action}`, status: 'applied', reasonCode: null }], error: null });
}

export { buildPullRequestSummary, reconcileSummaryComment, summaryContext, summaryMarker, syncPullRequestSummary };
