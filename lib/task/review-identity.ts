import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { resolveBranchWorktree } from '../git/branch-worktree.ts';
import { snapshotReview } from '../git/review-snapshot.ts';
import { resolveDeliveryTarget } from './delivery-target.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import {
  extractReviewDiffBase,
  extractReviewDiffFingerprint,
  extractReviewedHead,
  extractReviewTargetHead,
  extractReviewedSnapshotTree,
  loadPostReviewConfig,
  resolvePostReviewGlobs
} from './review-fingerprint.ts';

export type ReviewIdentityResult = Readonly<{
  status: 'matched' | 'different' | 'indeterminate';
  message: string;
  reviewedHead: string | null;
  currentHead: string | null;
}>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function result(
  status: ReviewIdentityResult['status'], message: string,
  reviewedHead: string | null = null, currentHead: string | null = null
): ReviewIdentityResult {
  return { status, message, reviewedHead, currentHead };
}

type ReviewIdentityDetails = {
  reviewedHead: string;
  targetHead: string;
  diffBase: string;
  fingerprint: string;
  reviewedTree: string;
};

type ReviewContext = ReviewIdentityDetails & {
  metadata: ReturnType<typeof parseTypedTaskFrontmatter>;
  taskRepositoryRoot: string;
  gitRoot: string;
  baseline: string;
  currentHead: string;
};

function resolveReviewContext(
  taskDir: string,
  repositoryRoot: string | undefined,
  identity: ReviewIdentityDetails
): ReviewContext | ReviewIdentityResult {
  const metadata = parseTypedTaskFrontmatter(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'));
  const taskRepositoryRoot = repositoryRoot
    ? fs.realpathSync.native(repositoryRoot)
    : git(taskDir, ['rev-parse', '--show-toplevel']);
  const branch = String(metadata.branch ?? '').trim();
  const gitRoot = branch ? resolveBranchWorktree(taskRepositoryRoot, branch) : taskRepositoryRoot;
  if (!gitRoot) {
    return result('indeterminate', `Task branch '${branch}' is not checked out in a registered worktree`, identity.reviewedHead);
  }
  const currentHead = git(gitRoot, ['rev-parse', 'HEAD']);
  const baseline = git(gitRoot, ['rev-parse', `${identity.reviewedHead}^{commit}`]);
  if (baseline !== currentHead) return result('different', 'Reviewed commit differs from current HEAD', baseline, currentHead);
  return { ...identity, metadata, taskRepositoryRoot, gitRoot, baseline, currentHead };
}

function checkReviewTarget(context: ReviewContext): { computedDiffBase: string } | ReviewIdentityResult {
  const remote = String(context.metadata.delivery_remote ?? '').trim();
  const baseRef = String(context.metadata.delivery_base_ref ?? '').trim();
  if (!remote || !baseRef) return result('indeterminate', 'Task delivery target is not bound', context.baseline, context.currentHead);
  const target = resolveDeliveryTarget(context.gitRoot, { remote, baseRef });
  if (!target.ok) return result('indeterminate', target.message, context.baseline, context.currentHead);
  const currentTarget = git(context.gitRoot, ['rev-parse', `${context.targetHead}^{commit}`]);
  const computedDiffBase = git(context.gitRoot, ['merge-base', context.baseline, currentTarget]);
  if (git(context.gitRoot, ['rev-parse', `${context.diffBase}^{commit}`]) !== computedDiffBase) {
    return result('different', 'Saved review diff base no longer matches the current target', context.baseline, context.currentHead);
  }
  return { computedDiffBase };
}

function checkReviewWorktree(
  context: ReviewContext,
  repositoryRoot: string | undefined,
  computedDiffBase: string
): ReviewIdentityResult | null {
  const globs = resolvePostReviewGlobs({}, loadPostReviewConfig(repositoryRoot ?? context.taskRepositoryRoot));
  const trackedChanges = git(context.gitRoot, ['diff', '--name-only', '-z', context.baseline, '--', ...globs]);
  const untrackedChanges = git(context.gitRoot, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...globs]);
  if (trackedChanges || untrackedChanges) {
    return result('different', 'Reviewed worktree contains uncommitted changes', context.baseline, context.currentHead);
  }
  const snapshot = snapshotReview({
    cwd: context.gitRoot,
    mode: 'worktree',
    baseline: context.baseline,
    diffBase: computedDiffBase,
    globs
  });
  if (snapshot.fingerprint !== context.fingerprint) {
    return result('different', 'Reviewed diff fingerprint differs from the current worktree', context.baseline, context.currentHead);
  }
  if (snapshot.tree !== context.reviewedTree) {
    return result('different', 'Reviewed snapshot tree differs from the current worktree', context.baseline, context.currentHead);
  }
  return null;
}

export function inspectReviewIdentity(taskDir: string, reportContent: string, repositoryRoot?: string): ReviewIdentityResult {
  const reviewedHead = extractReviewedHead(reportContent);
  const targetHead = extractReviewTargetHead(reportContent);
  const diffBase = extractReviewDiffBase(reportContent);
  const fingerprint = extractReviewDiffFingerprint(reportContent);
  const reviewedTree = extractReviewedSnapshotTree(reportContent);
  if (!reviewedHead || !targetHead || !diffBase || !fingerprint || !reviewedTree) {
    return result('indeterminate', 'Review report is missing commit or snapshot identity', reviewedHead || null);
  }
  const identity = { reviewedHead, targetHead, diffBase, fingerprint, reviewedTree };
  try {
    const context = resolveReviewContext(taskDir, repositoryRoot, identity);
    if ('status' in context) return context;
    const target = checkReviewTarget(context);
    if ('status' in target) return target;
    const worktreeResult = checkReviewWorktree(context, repositoryRoot, target.computedDiffBase);
    if (worktreeResult) return worktreeResult;
    return result('matched', 'Review report matches the current commit and clean worktree', context.baseline, context.currentHead);
  } catch (error) {
    return result('indeterminate', error instanceof Error ? error.message : String(error), reviewedHead);
  }
}
